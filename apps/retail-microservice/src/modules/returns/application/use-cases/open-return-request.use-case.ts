import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnOpenPayload,
  OrderFulfillmentStatusEnum,
  ReturnRequestView,
  ReturnStatusEnum,
} from '@retail-inventory-system/contracts';

import { ReturnDomainException, ReturnErrorCodeEnum, ReturnRequest } from '../../domain';
import {
  IReturnEventsPublisherPort,
  IReturnOrderReaderPort,
  IReturnOrderSnapshot,
  IReturnRequestRepositoryPort,
  RETURN_EVENTS_PUBLISHER,
  RETURN_ORDER_READER,
  RETURN_REQUEST_REPOSITORY,
  RETURN_WINDOW_DAYS,
} from '../ports';
import { toReturnRequestView } from './return-view.factory';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Open Return Request is the buyer-facing entry into the RMA lifecycle: it opens a
// `ReturnRequest` against a shipped/delivered order, enforcing the policy gates the
// aggregate cannot see for itself (ADR-032).
//
// **Authorization is owner-or-staff** (ADR-024 / ADR-028 §7): a customer may open a
// return on **its own** order (`order.customerId === payload.customerId`), or a staff
// caller with `order:return-authorize` (folded into `isStaff`) may open one on any order.
//
// **Three cross-aggregate gates the model cannot enforce** (it sees neither the order nor
// sibling RMAs), all run here against the raw-SQL order reader + the RMA repository:
//   1. **Existence** — the order must exist (`RETURN_ORDER_NOT_FOUND`, 404).
//   2. **Return-eligibility window** — a `delivered` order is always returnable; a
//      `shipped` (or `partially-shipped`) one only within `RETURN_WINDOW_DAYS` of its ship
//      date. Neither shipped nor delivered → `RETURN_ORDER_NOT_RETURNABLE` (409);
//      shipped-but-past-window → `RETURN_WINDOW_EXPIRED` (409).
//   3. **Returnable quantity** — per requested line, `quantity ≤ ordered − cancelled −
//      already-returned`, where already-returned sums the line across the order's
//      **non-rejected** RMAs (a rejected RMA frees its quantity back). An unknown line →
//      `RETURN_ORDER_LINE_NOT_FOUND` (404); an over-request →
//      `RETURN_QUANTITY_EXCEEDS_RETURNABLE` (409).
//
// On success it opens the aggregate, persists it (the repository finalizes the
// `RMA-<year>-<pad8(id)>` number from the generated id), and emits
// `retail.return.requested` best-effort post-commit (ADR-020 / ADR-011 — the event is
// built here, after persistence concretizes the ids, never pulled from the aggregate).
@Injectable()
export class OpenReturnRequestUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_ORDER_READER)
    private readonly orderReader: IReturnOrderReaderPort,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @Inject(RETURN_WINDOW_DAYS)
    private readonly returnWindowDays: number,
    @InjectPinoLogger(OpenReturnRequestUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnOpenPayload): Promise<ReturnRequestView> {
    const { orderId, customerId, isStaff, reasonCategory, notes, lines, correlationId } = payload;
    const now = new Date();

    this.logger.info(
      { correlationId, orderId, customerId, isStaff, lineCount: lines.length },
      'Opening return request',
    );

    // 1. Resolve the order through the cross-module reader (404 if missing).
    const order = await this.orderReader.findOrderForReturn(orderId);
    if (!order) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_ORDER_NOT_FOUND,
        `Order ${orderId} not found for return`,
      );
    }

    // 2. Owner-or-staff: a non-staff caller must own the order. Staff bypasses the check.
    if (!isStaff && order.customerId !== customerId) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN,
        `Order ${orderId} is not accessible to actor ${customerId}`,
      );
    }

    // 3. Return-eligibility window.
    this.assertWithinReturnWindow(order, now);

    // 4. Returnable-quantity invariant per requested line.
    const alreadyReturned = await this.sumAlreadyReturnedByLine(orderId);
    for (const requestedLine of lines) {
      const orderLine = order.lines.find((l) => l.orderLineId === requestedLine.orderLineId);
      if (!orderLine) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_ORDER_LINE_NOT_FOUND,
          `Order line ${requestedLine.orderLineId} does not belong to order ${orderId}`,
        );
      }
      const returnable =
        orderLine.quantity -
        orderLine.cancelledQuantity -
        (alreadyReturned.get(requestedLine.orderLineId) ?? 0);
      if (requestedLine.quantity > returnable) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_QUANTITY_EXCEEDS_RETURNABLE,
          `Order line ${requestedLine.orderLineId}: cannot return ${requestedLine.quantity} of the ${returnable} returnable (ordered ${orderLine.quantity}, cancelled ${orderLine.cancelledQuantity}, already returned ${alreadyReturned.get(requestedLine.orderLineId) ?? 0})`,
        );
      }
    }

    // 5. Open the aggregate (it enforces ≥ 1 line + each line's positive quantity) and
    // persist. The RMA's buyer is the order's `customerId` (a staff caller opens on the
    // buyer's behalf), falling back to the resolved principal for the rare tombstoned
    // order. The repository finalizes the `RMA-<year>-…` number from the generated id.
    const request = ReturnRequest.open(
      {
        orderId,
        customerId: order.customerId ?? customerId,
        reasonCategory,
        notes: notes ?? null,
        lines,
      },
      now,
    );
    const saved = await this.repository.save(request);

    await this.emitRequested(saved, correlationId);

    this.logger.info(
      { correlationId, orderId, rmaId: saved.id, rmaNumber: saved.rmaNumber },
      'Return request opened',
    );
    return toReturnRequestView(saved);
  }

  // A `delivered` order is always returnable; a `shipped` / `partially-shipped` one only
  // within `RETURN_WINDOW_DAYS` of its ship date (the goods have physically left). Any
  // other fulfillment state (unfulfilled — including a cancelled order, which never
  // ships) is not returnable.
  private assertWithinReturnWindow(order: IReturnOrderSnapshot, now: Date): void {
    if (order.fulfillmentStatus === OrderFulfillmentStatusEnum.DELIVERED) {
      return;
    }
    if (
      order.fulfillmentStatus === OrderFulfillmentStatusEnum.SHIPPED ||
      order.fulfillmentStatus === OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED
    ) {
      const shippedFrom = order.shippedAt ?? order.deliveredAt;
      if (!shippedFrom) {
        // The fulfillment axis says shipped but no ship timestamp rolled up — treat as
        // not returnable rather than letting an unbounded window through.
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_ORDER_NOT_RETURNABLE,
          `Order ${order.orderId} reports shipped but carries no ship date`,
        );
      }
      const deadline = shippedFrom.getTime() + this.returnWindowDays * MS_PER_DAY;
      if (now.getTime() > deadline) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_WINDOW_EXPIRED,
          `Order ${order.orderId} is past its ${this.returnWindowDays}-day return window (shipped ${shippedFrom.toISOString()})`,
        );
      }
      return;
    }
    throw new ReturnDomainException(
      ReturnErrorCodeEnum.RETURN_ORDER_NOT_RETURNABLE,
      `Order ${order.orderId} is not in a returnable state (fulfillment: ${order.fulfillmentStatus})`,
    );
  }

  // Σ `return_line.quantity` per `order_line` across the order's **non-rejected** return
  // requests, from `RETURN_REQUEST_REPOSITORY.listByOrderId`. A rejected RMA frees its
  // quantity back to the returnable pool, so it is excluded. (Computed here rather than via
  // a second reader SQL method — it reuses the existing repository read and keeps the
  // order reader focused on the orders tables alone, ADR-032.)
  private async sumAlreadyReturnedByLine(orderId: number): Promise<Map<number, number>> {
    const existing = await this.repository.listByOrderId(orderId);
    const byLine = new Map<number, number>();
    for (const rma of existing) {
      if (rma.status === ReturnStatusEnum.REJECTED) {
        continue;
      }
      for (const line of rma.lines) {
        byLine.set(line.orderLineId, (byLine.get(line.orderLineId) ?? 0) + line.quantity);
      }
    }
    return byLine;
  }

  // Best-effort, post-commit (ADR-020). The save has already committed, so a publish
  // failure is warn-logged and swallowed. The event is built from the saved aggregate so
  // it carries the concrete id + finalized RMA number.
  private async emitRequested(request: ReturnRequest, correlationId: string): Promise<void> {
    try {
      await this.publisher.publishReturnRequested({
        rmaId: request.id!,
        rmaNumber: request.rmaNumber!,
        orderId: request.orderId,
        customerId: request.customerId,
        requestedAt: request.requestedAt.toISOString(),
        lineCount: request.lines.length,
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, rmaId: request.id },
        'Failed to publish retail.return.requested (return already opened)',
      );
    }
  }
}
