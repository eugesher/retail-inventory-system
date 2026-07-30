import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IAllocationCancelPayload,
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IRetailOrderCancelLinePayload,
  OrderView,
} from '@retail-inventory-system/contracts';

import { Order, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderInventoryGatewayPort,
  IOrderRepositoryPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  OCC_RETRY_ATTEMPTS,
  ORDER_INVENTORY_GATEWAY,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { releaseAllocationWithRetry } from './cancel-allocation-retry';
import { countsTowardFulfilled, sumLineQuantitiesByOrderLine } from './fulfillment-quantities';
import { toOrderView } from './order-view.factory';
import { runWithOrderWriteRetry } from './order-write';

// Cancel Line cancels the **unshipped quantity of a single `OrderLine`** — a narrower
// unwind than Cancel Order (which terminates the whole order). It is for the case where
// one line of a multi-line order can no longer be fulfilled (out of stock, discontinued)
// while the rest of the order stands.
//
// **Authorization is staff-only** (`order:cancel` via `isStaffCancel`, ADR-031) — a
// line-level cancel is an operator action, **not** an owner operation (unlike Cancel
// Order, which a customer may run on its own pending order). A non-staff caller is
// rejected `ORDER_ACCESS_FORBIDDEN` (403).
//
// **The cancellation is recorded on the line.** `order_line.cancelled_quantity` is the
// durable count of units cancelled; `quantity − cancelled_quantity` is the line's
// **active** quantity. The cancellable amount is therefore
// `activeQuantity − alreadyFulfilled`, where `alreadyFulfilled` sums the line's quantity
// across the order's **non-`cancelled`** fulfillments (a cancelled shipment frees its
// slice back). An omitted `quantity` cancels all of it; one over it is rejected
// `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING` (409). An unknown line is `ORDER_LINE_NOT_FOUND`
// (404). Cancelling a line's last active unit moves it to the terminal `cancelled` status.
//
// Recording the count is what makes the operation **non-repeatable on the same units**.
// Before it was persisted, the remainder was recomputed as `ordered − alreadyFulfilled` on
// every call, so the same units could be cancelled again and again — each pass releasing
// their allocation once more, driving `quantity_allocated` below the truth (an unbounded
// over-release). The same blind spot let Create Fulfillment ship units whose allocation had
// already been released.
//
// **No money mutation, and no refund.** The line's money snapshot stands and the order's totals
// are untouched. Note the asymmetry with Cancel *Order*, which flags the payment and lets
// `OrderCancelledConsumer` auto-refund it: **cancelling a line moves no money and triggers
// nothing that will.** Refunding those units is a separate, deliberate Issue Refund call. This
// use case also emits **no event** — Cancel Line has no past-tense surface, so nothing
// downstream can react to it either.
//
// **Ordering** (the cross-cutting consistency rule, the Cancel Order posture): the local
// write commits FIRST, then the allocation release runs post-commit, retried then logged
// for operator replay. A failed release over-holds the stock until manual intervention but
// never corrupts the counters — and the committed count means a retry of the whole request
// can no longer re-cancel the same units. Releasing before the commit would reinstate the
// over-release on any rollback.
//
// **Version-checked OCC (ADR-036).** The cancelled count is aggregate state, so the write
// is a compare-and-swap on the order's `version`, bounded by `OCC_RETRY_ATTEMPTS`. Without
// it two concurrent Cancel Line calls could each read `cancelled_quantity = 0`, both commit
// their own `+1`, and lose one update — over-releasing exactly the way the missing column
// did. The order and its fulfillments are re-read INSIDE the retried callback, so a lost
// CAS recomputes the remainder against fresh committed state.
@Injectable()
export class CancelLineUseCase {
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
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(CancelLineUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailOrderCancelLinePayload): Promise<OrderView> {
    const { orderId, orderLineId, quantity, actorId, isStaffCancel, correlationId } = payload;

    this.logger.info(
      { correlationId, orderId, orderLineId, quantity, actorId, isStaffCancel },
      'Cancelling order line',
    );

    // Existence + the staff gate first, so a 404/403 never opens a transaction. Existence
    // is re-established inside the retried callback anyway (it reads fresh committed state).
    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FOUND,
        `Order ${orderId} not found`,
      );
    }
    if (!isStaffCancel) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN,
        `Order ${orderId} line cancel requires staff (order:cancel)`,
      );
    }

    const { saved, cancelledQuantity, variantId } = await runWithOrderWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      () => this.cancelLineInTransaction(orderId, orderLineId, quantity),
      { orderId, correlationId },
    );

    // Post-commit, best-effort with retry-then-log-for-replay: the cancellation is durable,
    // so a failed release over-holds rather than corrupts (the Cancel Order / Ship posture).
    await releaseAllocationWithRetry(
      this.inventoryGateway,
      CancelLineUseCase.buildCancelAllocationPayload(
        saved,
        variantId,
        cancelledQuantity,
        actorId,
        correlationId,
      ),
      this.logger,
      correlationId,
    );

    const payment = await this.paymentRepository.findByOrderId(orderId);

    this.logger.info(
      { correlationId, orderId, orderLineId, cancelledQuantity },
      'Order line cancelled',
    );
    return toOrderView(saved, payment);
  }

  // One attempt of the version-checked write: re-read the order and its fulfillments inside
  // the transaction, recompute the cancellable remainder from committed state, and save the
  // root with its `version` pinned. A lost CAS throws `OrderWriteConflictError`, which rolls
  // this transaction back; the retry helper re-enters with a fresh read.
  private cancelLineInTransaction(
    orderId: number,
    orderLineId: number,
    quantity: number | undefined,
  ): Promise<{ saved: Order; cancelledQuantity: number; variantId: number }> {
    return this.transactionPort.runInTransaction(async (scope) => {
      const order = await this.orderRepository.findById(orderId, scope);
      if (!order) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_NOT_FOUND,
          `Order ${orderId} vanished while cancelling a line`,
        );
      }
      const line = order.lines.find((candidate) => candidate.id === orderLineId);
      if (!line) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_LINE_NOT_FOUND,
          `Order line ${orderLineId} does not belong to order ${orderId}`,
        );
      }

      const fulfillments = await this.fulfillmentRepository.listByOrderId(orderId, scope);
      const alreadyFulfilled =
        sumLineQuantitiesByOrderLine(fulfillments, countsTowardFulfilled).get(orderLineId) ?? 0;
      const cancellable = line.activeQuantity - alreadyFulfilled;
      const cancelQty = quantity ?? cancellable;
      if (cancelQty <= 0 || cancelQty > cancellable) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
          `Order line ${orderLineId}: cannot cancel ${cancelQty} of the ${cancellable} cancellable (ordered ${line.quantity}, already cancelled ${line.cancelledQuantity}, already fulfilled ${alreadyFulfilled})`,
        );
      }

      const versionAtLoad = order.version;
      order.cancelLineQuantity(orderLineId, cancelQty);
      const saved = await this.orderRepository.save(order, scope, versionAtLoad);

      return { saved, cancelledQuantity: cancelQty, variantId: line.variantId };
    });
  }

  // The single-line cancel-allocation: the cancelled quantity of one variant at
  // `default-warehouse` (where Place allocated). `reason 'line-cancelled'` distinguishes
  // the ledger movement from a whole-order cancellation.
  private static buildCancelAllocationPayload(
    order: Order,
    variantId: number,
    quantity: number,
    actorId: string,
    correlationId: string,
  ): Omit<IAllocationCancelPayload, 'operationKey'> {
    return {
      orderId: order.id!,
      lines: [{ variantId, stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION, quantity }],
      reason: 'line-cancelled',
      actorId,
      correlationId,
    };
  }
}
