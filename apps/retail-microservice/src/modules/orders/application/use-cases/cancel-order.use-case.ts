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
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderInventoryGatewayPort,
  IOrderRepositoryPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  OCC_RETRY_ATTEMPTS,
  ORDER_CUSTOMER_CONTACT_READER,
  ORDER_EVENTS_PUBLISHER,
  ORDER_INVENTORY_GATEWAY,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { releaseAllocationWithRetry } from './cancel-allocation-retry';
import { loadAuthorizedOrder } from './order-access';
import { runWithOrderWriteRetry } from './order-write';
import { toOrderView } from './order-view.factory';
import { resolveCustomerEmail } from './resolve-customer-email';

// Cancel Order is the **pre-fulfillment unhappy terminal** (ADR-031): it unwinds an
// order that has not yet shipped. It is the mirror of Ship — where Ship takes the money,
// moves the stock, and advances toward delivery, Cancel settles the payment the other
// way (void an authorization / flag a capture for refund) and releases the stock back to
// `available`.
//
// Authorization goes through `loadAuthorizedOrder` (the rule is stated there, once); the override is
// `order:cancel`. **A customer may cancel its own order** — unlike Cancel *Line*, which is
// staff-only.
//
// **Precondition — no physically-shipped stock can be stranded.** The order must have
// **no `shipped`/`delivered` fulfillment** (`ORDER_NOT_CANCELLABLE`, 409). This is the
// real guard: the order's lifecycle axis stays `pending` after a ship (Ship advances
// only the fulfillment axis), so the domain `order.cancel()` lifecycle check alone would
// not catch a shipped order — the fulfillment-presence check does. `pending` fulfillments
// are allowed; they are cancelled along with the order.
//
// **The payment outcome splits on whether the money already moved** (ADR-031). An `authorized`
// payment is **voided** — nothing was taken, nothing is owed. A `captured` one is **flagged for
// refund**: the money is gone, so cancellation cannot undo it, and `flagged_for_refund = true` is a
// *claim* that a refund is owed. **The flag alone gives nobody their money back** — retail's own
// `OrderCancelledConsumer` reads the cancellation event and issues the refund.
//
// The order's payment *axis* keeps its value: there is no `voided` member on
// `OrderPaymentStatusEnum`. Only the `payment` row carries `voided` — the deliberate orthogonality
// of ADR-028 §2.
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
    @Inject(ORDER_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IOrderCustomerContactReaderPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
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

    // Local transaction under the bounded OCC retry (ADR-036): cancel the order, cancel
    // any `pending` fulfillments, and settle the payment — atomically. Everything is
    // (re-)loaded INSIDE the callback (the order + its fulfillments + the payment), so a
    // lost order CAS re-runs the whole unit of work against fresh, committed state and
    // the payment mutators stay valid on a retry. Returns whether a captured payment was
    // flagged for refund (the post-commit event branches on it).
    const paymentFlaggedForRefund = await runWithOrderWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      () =>
        this.transactionPort.runInTransaction<boolean>(async (scope) => {
          const freshOrder = await this.orderRepository.findById(orderId, scope);
          if (!freshOrder) {
            throw new OrderDomainException(
              OrderErrorCodeEnum.ORDER_NOT_FOUND,
              `Order ${orderId} vanished while cancelling`,
            );
          }
          const versionAtLoad = freshOrder.version;

          // Re-acquire the order's fulfillments under a pessimistic write lock — a CURRENT
          // read that serialises against a concurrent Ship of the same order. The
          // pre-transaction `hasShippedFulfillment` check above is a fast fail for the
          // uncontended path; this in-transaction re-check under the lock is the guard that
          // holds under contention: a Ship that is committing now blocks this read until it
          // commits, and the freshly-observed `shipped` status then rejects the cancel
          // (`ORDER_NOT_CANCELLABLE`). Conversely a Ship that starts while this holds the
          // lock blocks until this commits and then sees the `cancelled` fulfillment
          // (the single-writer-per-status-transition guard, ADR-031).
          const locked: Fulfillment[] = [];
          for (const planned of await this.fulfillmentRepository.listByOrderId(orderId, scope)) {
            const lockedFulfillment = await this.fulfillmentRepository.findByIdForUpdate(
              planned.id!,
              scope,
            );
            if (lockedFulfillment) {
              locked.push(lockedFulfillment);
            }
          }
          if (CancelOrderUseCase.hasShippedFulfillment(locked)) {
            throw new OrderDomainException(
              OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE,
              `Order ${orderId} has a shipped or delivered fulfillment and cannot be cancelled`,
            );
          }

          freshOrder.cancel();

          // Cancel every `pending` fulfillment (a planned-but-not-shipped shipment).
          for (const fulfillment of locked) {
            if (fulfillment.status === FulfillmentStatusEnum.PENDING) {
              fulfillment.cancel();
              await this.fulfillmentRepository.save(fulfillment, scope);
            }
          }

          // Re-load the payment within this attempt's transaction so its mutators
          // (`flagForRefund` / `void`) stay valid on a retry. **`FOR UPDATE`, not a snapshot read**
          // — this must observe a capture claim taken by a concurrent Ship or Capture, and a
          // REPEATABLE READ snapshot would not (ADR-052).
          const payment = await this.paymentRepository.findByOrderIdForUpdate(orderId, scope);
          let flagged = false;
          if (payment) {
            // **A capture is in flight: REFUSE.** This is the branch that makes the claim worth
            // having. `CAPTURING` means a caller has committed its claim and may already have charged
            // the gateway — the call is out of process and there is no way to ask whether it landed.
            // Voiding here would void an authorization whose money is gone (the old behaviour: the
            // customer charged, the order cancelled, the row reading `VOIDED`, and **nothing in the
            // system aware there was anything to reconcile**). Flagging for refund would be a guess in
            // the other direction. So the cancel loses the race, cleanly, and the caller may retry
            // once the capture resolves — seconds later, or after an operator clears a stale claim.
            if (payment.status === PaymentStatusEnum.CAPTURING) {
              throw new OrderDomainException(
                OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE,
                `Order ${orderId} has a payment capture in flight and cannot be cancelled; retry once it settles`,
              );
            }
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

          // The order header cancel is the version-checked CAS — a concurrent order
          // writer that advanced the version makes it lose and the unit of work retry.
          await this.orderRepository.save(freshOrder, scope, versionAtLoad);
          return flagged;
        }),
      { orderId, correlationId },
    );

    // After the local commit: release the order's stock allocation. Best-effort with
    // retry-then-log-for-replay — never rolls the cancel back (ADR-031). A line whose units
    // were all cancelled beforehand holds no allocation, so it contributes nothing; if that
    // is every line, there is nothing to release and inventory would reject the empty
    // payload outright.
    const allocationPayload = CancelOrderUseCase.buildCancelAllocationPayload(
      order,
      actorId,
      correlationId,
    );
    if (allocationPayload.lines.length > 0) {
      await releaseAllocationWithRetry(
        this.inventoryGateway,
        allocationPayload,
        this.logger,
        correlationId,
      );
    }

    // Resolve the buyer's email so the cancellation-confirmation consumer (which now binds
    // `retail.order.cancelled` off `notification_events`) has a recipient without a
    // per-delivery RPC (ADR-033). Best-effort: a tombstoned/missing customer or a reader
    // hiccup yields `null` (the helper never throws).
    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      order.customerId,
      this.logger,
      correlationId,
    );

    await this.emitCancelled(
      orderId,
      customerEmail,
      reason ?? null,
      paymentFlaggedForRefund,
      correlationId,
    );

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

  // Releases the allocation the order still holds. Nothing has shipped (the precondition),
  // so each line's place-time allocation is intact **except** for units a prior Cancel Line
  // already cancelled and released — hence `activeQuantity`, not `quantity` (ADR-040).
  // Releasing the ordered quantity here would free those units a second time and drive the
  // shared per-`(variant, location)` `quantity_allocated` below the truth, eating other
  // orders' allocations. A fully-cancelled line holds nothing and is dropped: inventory
  // rejects a non-positive line quantity.
  //
  // The cancel releases from `default-warehouse` because **that is where Place allocated it** — an
  // order is allocated from exactly one location and the system records no other. `reason
  // 'order-cancelled'` is the movement's `reason_code`, distinct from the optional human `reason`
  // that rides the event.
  private static buildCancelAllocationPayload(
    order: Order,
    actorId: string,
    correlationId: string,
  ): Omit<IAllocationCancelPayload, 'operationKey'> {
    return {
      orderId: order.id!,
      lines: order.lines
        .filter((line) => line.activeQuantity > 0)
        .map((line) => ({
          variantId: line.variantId,
          stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION,
          quantity: line.activeQuantity,
        })),
      reason: 'order-cancelled',
      actorId,
      correlationId,
    };
  }

  // Best-effort, post-commit (ADR-020). The cancel has already committed, so a publish
  // failure is warn-logged and swallowed. `customerEmail` is the buyer's resolved contact (or
  // `null`); `customerLocale` ships `null` (locale resolution deferred).
  private async emitCancelled(
    orderId: number,
    customerEmail: string | null,
    reason: string | null,
    paymentFlaggedForRefund: boolean,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishOrderCancelled({
        orderId,
        customerEmail,
        customerLocale: null,
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
