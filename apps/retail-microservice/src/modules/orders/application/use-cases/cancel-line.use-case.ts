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
  ORDER_INVENTORY_GATEWAY,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
} from '../ports';
import { releaseAllocationWithRetry } from './cancel-allocation-retry';
import { countsTowardFulfilled, sumLineQuantitiesByOrderLine } from './fulfillment-quantities';
import { toOrderView } from './order-view.factory';

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
// **Unshipped quantity only.** The cancellable quantity is `ordered − alreadyFulfilled`,
// where `alreadyFulfilled` is the sum of the line's quantity across the order's
// **non-`cancelled`** fulfillments (the same remainder Create measures — a cancelled
// shipment frees its slice back). A `quantity` omitted cancels all the remaining
// unshipped; a `quantity` over the remainder is rejected
// `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING` (409). An unknown line is `ORDER_LINE_NOT_FOUND`
// (404).
//
// **No money mutation.** This operation releases the cancelled quantity's stock
// allocation (proportionally, the same `inventory.allocation.cancel` Cancel Order uses)
// and records nothing on the order's money totals — a credit/refund is the later refund
// capability's job. The order is **not** otherwise mutated (other lines/quantities stand),
// and this capability emits **no event** (Cancel Line has no past-tense surface). The
// allocation release is best-effort with retry-then-log-for-replay (the Cancel Order /
// Ship posture) — a failed release over-holds until manual intervention, never corrupts.
@Injectable()
export class CancelLineUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(ORDER_INVENTORY_GATEWAY)
    private readonly inventoryGateway: IOrderInventoryGatewayPort,
    @InjectPinoLogger(CancelLineUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailOrderCancelLinePayload): Promise<OrderView> {
    const { orderId, orderLineId, quantity, actorId, isStaffCancel, correlationId } = payload;

    this.logger.info(
      { correlationId, orderId, orderLineId, quantity, actorId, isStaffCancel },
      'Cancelling order line',
    );

    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FOUND,
        `Order ${orderId} not found`,
      );
    }
    // Staff-only — a line-level cancel is never an owner operation (ADR-031).
    if (!isStaffCancel) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN,
        `Order ${orderId} line cancel requires staff (order:cancel)`,
      );
    }

    const line = order.lines.find((l) => l.id === orderLineId);
    if (!line) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_NOT_FOUND,
        `Order line ${orderLineId} does not belong to order ${orderId}`,
      );
    }

    // The cancellable unshipped remainder = ordered − Σ (this line's quantity across the
    // order's non-`cancelled` fulfillments). An omitted `quantity` cancels all of it.
    const fulfillments = await this.fulfillmentRepository.listByOrderId(orderId);
    const alreadyFulfilled =
      sumLineQuantitiesByOrderLine(fulfillments, countsTowardFulfilled).get(orderLineId) ?? 0;
    const remaining = line.quantity - alreadyFulfilled;
    const cancelQty = quantity ?? remaining;
    if (cancelQty <= 0 || cancelQty > remaining) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
        `Order line ${orderLineId}: cannot cancel ${cancelQty} of the ${remaining} unshipped (ordered ${line.quantity}, already fulfilled ${alreadyFulfilled})`,
      );
    }

    // Release just the cancelled quantity's allocation — the order's other lines and the
    // already-fulfilled quantity of this line are untouched. Best-effort with
    // retry-then-log-for-replay (no money mutation, no event).
    await releaseAllocationWithRetry(
      this.inventoryGateway,
      this.buildCancelAllocationPayload(order, line.variantId, cancelQty, actorId, correlationId),
      this.logger,
      correlationId,
    );

    // The order itself is not mutated; re-read nothing — fold the current payment onto
    // the view for completeness.
    const payment = await this.paymentRepository.findByOrderId(orderId);

    this.logger.info(
      { correlationId, orderId, orderLineId, cancelledQuantity: cancelQty },
      'Order line cancelled',
    );
    return toOrderView(order, payment);
  }

  // The single-line cancel-allocation: the cancelled quantity of one variant at
  // `default-warehouse` (where Place allocated). `reason 'line-cancelled'` distinguishes
  // the ledger movement from a whole-order cancellation.
  private buildCancelAllocationPayload(
    order: Order,
    variantId: number,
    quantity: number,
    actorId: string,
    correlationId: string,
  ): IAllocationCancelPayload {
    return {
      orderId: order.id!,
      lines: [{ variantId, stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION, quantity }],
      reason: 'line-cancelled',
      actorId,
      correlationId,
    };
  }
}
