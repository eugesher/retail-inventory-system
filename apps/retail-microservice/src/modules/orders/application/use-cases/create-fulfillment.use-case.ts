import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentView,
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IRetailFulfillmentCreatePayload,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

import { Fulfillment, Order, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
} from '../ports';
import { countsTowardFulfilled, sumLineQuantitiesByOrderLine } from './fulfillment-quantities';
import { loadAuthorizedOrder } from './order-access';
import { toFulfillmentView } from './fulfillment-view.factory';

// Create Fulfillment: plans a shipment of one or more `OrderLine` quantities — the
// first fulfillment operation (ADR-031). It opens a `pending` `Fulfillment` against an
// order; the actual ship (capture payment + move stock + advance the fulfillment axis)
// is the separate Ship operation. A placed order can be fulfilled in **parts** — each
// `Fulfillment` carries a slice of the ordered quantities, and an order resolves to a
// list of them.
//
// **Authorization is owner-or-staff** (ADR-024 / ADR-028 §7), enforced here as the
// single point of truth via `loadAuthorizedOrder`: allow if `isStaffFulfill` (the
// gateway already confirmed the caller carries `order:fulfill`) **or**
// `order.customerId === actorId` (the owning customer) — else `ORDER_ACCESS_FORBIDDEN`
// (403); a missing order is 404. Practically Create is staff-run, but the
// owner-or-staff shape keeps the module's one authorization model.
//
// **Preconditions** (an order must be in a fulfillable state):
// - lifecycle `status ∈ {pending, confirmed}` — a cancelled/shipped/delivered order is
//   rejected `ORDER_NOT_FULFILLABLE` (409);
// - payment `paymentStatus ∈ {authorized, captured}` — an order with nothing
//   authorized to pay for the shipment is rejected `ORDER_NOT_FULFILLABLE` (409). The
//   payment axis lives on the `Order` header, so no separate `Payment` load is needed.
//
// **The cross-fulfillment quantity invariant** (the heart of this use case): the
// aggregate cannot see its sibling fulfillments or the order's line quantities, so it
// only enforces its own shape (≥ 1 line, each quantity > 0). The use case enforces the
// rest: each requested `orderLineId` must belong to the order (`ORDER_LINE_NOT_FOUND`,
// 404), and `alreadyFulfilled + requested ≤ ordered` measured against the
// **already-fulfilled remainder** — the sum of that line's quantities across all the
// order's existing non-`cancelled` fulfillments — else
// `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING` (409).
//
// **Side-effect-free on the order header.** Create yields a `pending` `Fulfillment`
// and leaves the order/line statuses untouched. A line's `partially-shipped` status is
// observed once units are *in flight*, which is the Ship operation's job — keeping
// Create a single repository write with no order-header churn.
@Injectable()
export class CreateFulfillmentUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @InjectPinoLogger(CreateFulfillmentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailFulfillmentCreatePayload): Promise<FulfillmentView> {
    const { orderId, stockLocationId, lines, actorId, isStaffFulfill, correlationId } = payload;

    this.logger.info(
      { correlationId, orderId, actorId, isStaffFulfill, lineCount: lines.length },
      'Creating fulfillment',
    );

    // Owner-or-staff authorization + existence (404 missing / 403 non-owner-non-staff).
    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffFulfill);

    // The order must be in a fulfillable lifecycle + payment state.
    CreateFulfillmentUseCase.assertFulfillable(order);

    // The cross-fulfillment quantity invariant — load the order's existing
    // fulfillments and measure each requested quantity against the remaining unshipped
    // count per order line.
    await this.assertWithinRemaining(order, lines);

    // `Fulfillment.create` is the shape authority: it rejects empty lines
    // (`FULFILLMENT_NO_LINES`) and a non-positive line quantity
    // (`FULFILLMENT_LINE_QUANTITY_INVALID`) — checks the use case deliberately leaves
    // to the aggregate. A single `save` is one transaction (root + lines + re-read);
    // Create touches no other aggregate, so no shared `scope` is needed.
    const fulfillment = Fulfillment.create({
      orderId,
      stockLocationId: stockLocationId ?? INVENTORY_DEFAULT_STOCK_LOCATION,
      lines: lines.map((line) => ({ orderLineId: line.orderLineId, quantity: line.quantity })),
    });
    const saved = await this.fulfillmentRepository.save(fulfillment);

    // Emit the past-tense event best-effort, post-commit (ADR-020) — built from the
    // saved aggregate's concrete ids.
    await this.emitCreated(saved, correlationId);

    this.logger.info(
      { correlationId, orderId, fulfillmentId: saved.id, status: saved.status },
      'Fulfillment created',
    );
    return toFulfillmentView(saved);
  }

  // Order-level preconditions — both surface the same `ORDER_NOT_FULFILLABLE` (409),
  // since either makes the order un-shippable. The fulfillment does not exist yet, so
  // this is an order-state breach, not a `Fulfillment` status-transition breach.
  private static assertFulfillable(order: Order): void {
    if (order.status !== OrderStatusEnum.PENDING && order.status !== OrderStatusEnum.CONFIRMED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FULFILLABLE,
        `Order ${order.id} is ${order.status} and cannot be fulfilled`,
      );
    }
    if (
      order.paymentStatus !== OrderPaymentStatusEnum.AUTHORIZED &&
      order.paymentStatus !== OrderPaymentStatusEnum.CAPTURED
    ) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FULFILLABLE,
        `Order ${order.id} payment is ${order.paymentStatus}; an authorized or captured payment is required to fulfill`,
      );
    }
  }

  // For each requested line: the `orderLineId` must belong to the order (404), and the
  // already-fulfilled-plus-requested quantity must not exceed the ordered quantity
  // (409, the remaining count carried in the message). "Already fulfilled" sums the
  // line's quantities across every existing **non-`cancelled`** fulfillment — a
  // cancelled shipment frees its slice back to the remaining pool.
  private async assertWithinRemaining(
    order: Order,
    lines: { orderLineId: number; quantity: number }[],
  ): Promise<void> {
    const orderId = order.id!;
    const orderedByLine = new Map<number, number>();
    for (const line of order.lines) {
      orderedByLine.set(line.id!, line.quantity);
    }

    const existing = await this.fulfillmentRepository.listByOrderId(orderId);
    const alreadyByLine = sumLineQuantitiesByOrderLine(existing, countsTowardFulfilled);

    // Aggregate the request by `orderLineId` first, so two entries for the same line in
    // one request are summed before the comparison — otherwise each entry would be
    // checked against the remainder independently and a split request could over-ship a
    // single line.
    const requestedByLine = new Map<number, number>();
    for (const requested of lines) {
      if (!orderedByLine.has(requested.orderLineId)) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_LINE_NOT_FOUND,
          `Order line ${requested.orderLineId} does not belong to order ${orderId}`,
        );
      }
      requestedByLine.set(
        requested.orderLineId,
        (requestedByLine.get(requested.orderLineId) ?? 0) + requested.quantity,
      );
    }

    for (const [orderLineId, requested] of requestedByLine) {
      const ordered = orderedByLine.get(orderLineId)!;
      const already = alreadyByLine.get(orderLineId) ?? 0;
      const remaining = ordered - already;
      if (requested > remaining) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
          `Order line ${orderLineId}: requested ${requested} exceeds the remaining ${remaining} (ordered ${ordered}, already fulfilled ${already})`,
        );
      }
    }
  }

  // Best-effort, post-commit (ADR-020). The fulfillment write has already committed, so
  // a publish failure is warn-logged and swallowed — it never fails the create.
  private async emitCreated(fulfillment: Fulfillment, correlationId: string): Promise<void> {
    try {
      await this.publisher.publishFulfillmentCreated({
        orderId: fulfillment.orderId,
        fulfillmentId: fulfillment.id!,
        stockLocationId: fulfillment.stockLocationId,
        lineQuantities: fulfillment.lines.map((line) => ({
          orderLineId: line.orderLineId,
          quantity: line.quantity,
        })),
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, fulfillmentId: fulfillment.id },
        'Failed to publish retail.fulfillment.created (fulfillment already committed)',
      );
    }
  }
}
