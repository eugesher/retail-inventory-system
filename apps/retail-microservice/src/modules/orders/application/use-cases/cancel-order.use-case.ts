import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentStatusEnum,
  IAllocationCancelPayload,
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IRetailOrderCancelPayload,
  OrderView,
  PaymentStatusEnum,
} from '@retail-inventory-system/contracts';

import { Fulfillment, Order, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderEventsPublisherPort,
  IOrderInventoryGatewayPort,
  IOrderRepositoryPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  ORDER_EVENTS_PUBLISHER,
  ORDER_INVENTORY_GATEWAY,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { releaseAllocationWithRetry } from './cancel-allocation-retry';
import { loadAuthorizedOrder } from './order-access';
import { toOrderView } from './order-view.factory';

// Cancel Order is the **pre-fulfillment unhappy terminal** (ADR-031): it unwinds an
// order that has not yet shipped. It is the mirror of Ship — where Ship takes the money,
// moves the stock, and advances toward delivery, Cancel settles the payment the other
// way (void an authorization / flag a capture for refund) and releases the stock back to
// `available`.
//
// **Authorization is owner-or-staff** (ADR-024 / ADR-028 §7) via `loadAuthorizedOrder`:
// a customer may cancel **its own** pending order (`order.customerId === actorId`), or a
// staff caller with `order:cancel` (folded into `isStaffCancel`) may cancel any.
//
// **Precondition — no physically-shipped stock can be stranded.** The order must have
// **no `shipped`/`delivered` fulfillment** (`ORDER_NOT_CANCELLABLE`, 409). This is the
// real guard: the order's lifecycle axis stays `pending` after a ship (Ship advances
// only the fulfillment axis), so the domain `order.cancel()` lifecycle check alone would
// not catch a shipped order — the fulfillment-presence check does. `pending` fulfillments
// are allowed; they are cancelled along with the order.
//
// **Payment outcome split** (ADR-028 §6 / ADR-031): a `captured` payment is **flagged for
// refund** (the money is gone — `flagged_for_refund = true`; the later refund capability
// issues the actual refund), an `authorized` payment is **voided** (the held authorization
// is released, no money ever taken). The order's payment *axis* keeps its value — there is
// no `voided` member on `OrderPaymentStatusEnum`; the `payment` row carries `voided`, the
// deliberate orthogonality of ADR-028 §2.
//
// **Ordering** (the cross-cutting consistency rule): the local writes (cancel the order,
// cancel `pending` fulfillments, settle the payment) commit first; the allocation release
// runs **after** the local commit (its own RPC into inventory's own transaction), retried
// then logged for operator replay — a failed release over-holds the stock until manual
// intervention but never corrupts the counters, and the local cancel is never rolled back.
@Injectable()
export class CancelOrderUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(ORDER_INVENTORY_GATEWAY)
    private readonly inventoryGateway: IOrderInventoryGatewayPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @InjectPinoLogger(CancelOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailOrderCancelPayload): Promise<OrderView> {
    const { orderId, reason, actorId, isStaffCancel, correlationId } = payload;

    this.logger.info(
      { correlationId, orderId, actorId, isStaffCancel, reason },
      'Cancelling order',
    );

    // Owner-or-staff authorization + existence (404 missing / 403 non-owner-non-staff).
    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffCancel);

    // Precondition: no `shipped`/`delivered` fulfillment exists — the order's lifecycle
    // stays `pending` after a ship, so this fulfillment-presence check (not the lifecycle
    // axis) is what protects physically-shipped stock from being stranded.
    const fulfillments = await this.fulfillmentRepository.listByOrderId(orderId);
    if (CancelOrderUseCase.hasShippedFulfillment(fulfillments)) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE,
        `Order ${orderId} has a shipped or delivered fulfillment and cannot be cancelled`,
      );
    }

    // The payment is loaded outside the transaction (its repository read is not
    // scope-aware) and mutated + saved inside.
    const payment = await this.paymentRepository.findByOrderId(orderId);

    // Local transaction: cancel the order, cancel any `pending` fulfillments, and settle
    // the payment — atomically. Returns whether a captured payment was flagged for refund
    // (the post-commit event branches on it).
    const paymentFlaggedForRefund = await this.transactionPort.runInTransaction<boolean>(
      async (scope) => {
        const freshOrder = await this.orderRepository.findById(orderId, scope);
        if (!freshOrder) {
          throw new OrderDomainException(
            OrderErrorCodeEnum.ORDER_NOT_FOUND,
            `Order ${orderId} vanished while cancelling`,
          );
        }
        freshOrder.cancel();

        // Cancel every `pending` fulfillment (a planned-but-not-shipped shipment).
        const fresh = await this.fulfillmentRepository.listByOrderId(orderId, scope);
        for (const fulfillment of fresh) {
          if (fulfillment.status === FulfillmentStatusEnum.PENDING) {
            fulfillment.cancel();
            await this.fulfillmentRepository.save(fulfillment, scope);
          }
        }

        let flagged = false;
        if (payment) {
          if (payment.status === PaymentStatusEnum.CAPTURED) {
            payment.flagForRefund();
            flagged = true;
            await this.paymentRepository.save(payment, scope);
          } else if (payment.status === PaymentStatusEnum.AUTHORIZED) {
            payment.void();
            await this.paymentRepository.save(payment, scope);
          }
          // A payment in any other state (already voided/refunded/failed) is left as-is.
        }

        await this.orderRepository.save(freshOrder, scope);
        return flagged;
      },
    );

    // After the local commit: release the order's stock allocation. Best-effort with
    // retry-then-log-for-replay — never rolls the cancel back (ADR-031).
    await releaseAllocationWithRetry(
      this.inventoryGateway,
      this.buildCancelAllocationPayload(order, actorId, correlationId),
      this.logger,
      correlationId,
    );

    await this.emitCancelled(orderId, reason ?? null, paymentFlaggedForRefund, correlationId);

    // Re-read so the view carries the cancelled lifecycle + the settled payment.
    const [finalOrder, finalPayment] = await Promise.all([
      this.orderRepository.findById(orderId),
      this.paymentRepository.findByOrderId(orderId),
    ]);
    if (!finalOrder) {
      throw new Error(`CancelOrderUseCase: order ${orderId} vanished after cancel`);
    }

    this.logger.info({ correlationId, orderId, paymentFlaggedForRefund }, 'Order cancelled');
    return toOrderView(finalOrder, finalPayment);
  }

  private static hasShippedFulfillment(fulfillments: Fulfillment[]): boolean {
    return fulfillments.some(
      (f) =>
        f.status === FulfillmentStatusEnum.SHIPPED || f.status === FulfillmentStatusEnum.DELIVERED,
    );
  }

  // Releases the order's full allocation — nothing has shipped (the precondition), so the
  // place-time allocation is intact for every line at its ordered quantity. The line's
  // allocation location is `default-warehouse` (Place allocated there); a multi-location
  // sourcing record is a later capability. `reason 'order-cancelled'` is the movement's
  // `reason_code` (distinct from the optional human `reason` on the event).
  private buildCancelAllocationPayload(
    order: Order,
    actorId: string,
    correlationId: string,
  ): IAllocationCancelPayload {
    return {
      orderId: order.id!,
      lines: order.lines.map((line) => ({
        variantId: line.variantId,
        stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION,
        quantity: line.quantity,
      })),
      reason: 'order-cancelled',
      actorId,
      correlationId,
    };
  }

  // Best-effort, post-commit (ADR-020). The cancel has already committed, so a publish
  // failure is warn-logged and swallowed.
  private async emitCancelled(
    orderId: number,
    reason: string | null,
    paymentFlaggedForRefund: boolean,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishOrderCancelled({
        orderId,
        cancelledAt: new Date().toISOString(),
        reason,
        paymentFlaggedForRefund,
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, orderId },
        'Failed to publish retail.order.cancelled (cancel already committed)',
      );
    }
  }
}
