import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentStatusEnum,
  FulfillmentView,
  ICommitSalePayload,
  IRetailFulfillmentShipPayload,
  OrderFulfillmentStatusEnum,
  OrderLineStatusEnum,
  PaymentStatusEnum,
} from '@retail-inventory-system/contracts';

import {
  Fulfillment,
  Order,
  OrderDomainException,
  OrderErrorCodeEnum,
  Payment,
} from '../../domain';
import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderCommitSaleGatewayPort,
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  ORDER_COMMIT_SALE_GATEWAY,
  ORDER_CUSTOMER_CONTACT_READER,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { countsTowardShipped, sumLineQuantitiesByOrderLine } from './fulfillment-quantities';
import { loadAuthorizedOrder } from './order-access';
import { toFulfillmentView } from './fulfillment-view.factory';
import { resolveCustomerEmail } from './resolve-customer-email';
import { retryThenLogForReplay } from './retry-then-log-for-replay';

// How many times Commit Sale is attempted after the local ship commit before the
// failure is logged for operator replay. Commit Sale is idempotent on `fulfillmentId`
// inventory-side, so a retry never double-decrements (ADR-031). Retries are immediate
// (no backoff) — a backoff is a later refinement and would only complicate the
// unit tests; the realistic failure is a transient RMQ hiccup the broker recovers from.
const COMMIT_SALE_MAX_ATTEMPTS = 3;

// The outcome of the ship-triggered capture decision (Q5). A non-null `capturedAt` says
// THIS ship took the money (an `authorized` payment) — driving the in-transaction
// `payment.capture` + `order.markPaymentCaptured` and the post-commit
// `retail.payment.captured` emit; `null` means it was skipped (an already-`captured`
// payment). One nullable field carries the decision — no redundant boolean, no `!`.
interface ICaptureOutcome {
  capturedAt: Date | null;
}

// Ship Fulfillment — the operation that physically moves stock and takes the money
// (ADR-031). It is the single operation that **advances three axes and crosses the
// service boundary**: it captures payment (payment axis), advances the order's
// fulfillment axis + each shipped line's status, and physically decrements inventory
// via Commit Sale.
//
// **Authorization is owner-or-staff** (ADR-024 / ADR-028 §7) via `loadAuthorizedOrder`:
// allow if `isStaffFulfill` (the gateway already confirmed `order:fulfill`) **or**
// `order.customerId === actorId`. Practically Ship is staff-run.
//
// **Ship-triggered automatic capture (Q5).** Before any local write, the ship inspects
// the payment: an `authorized` payment is captured **inline, out-of-process, before
// the local commit** (the `CapturePaymentUseCase` template — the gateway call is
// outside the DB transaction); an already-`captured` payment skips the gateway. The
// compensation on a capture decline is **block-ship-until-payment-succeeds**: a decline
// aborts the ship (`ORDER_PAYMENT_NOT_CAPTURED`, 409) with nothing written — no
// fulfillment transition, no Commit Sale. There is no partial saga and no
// `pending-with-payment-failure` state to reconcile (ADR-031).
//
// **Ordering** (the cross-cutting consistency rule): capture runs **before** the local
// commit (so money is never taken for a ship that then fails its own preconditions —
// which is also why `trackingNumber` is validated up front, before the capture);
// Commit Sale runs **after** the local commit (eventual consistency on the inventory
// decrement — a transient failure is retried, a hard failure is logged for operator
// replay, and the local ship is **never** rolled back, because the money is taken and
// the box has left — Commit Sale's `fulfillmentId` idempotency makes the replay safe).
//
// **The order's fulfillment roll-up is derived from the order's fulfillments' shipped
// line quantities** — the authority is the `fulfillment` graph, not `order_line.status`
// (the latter is the denormalized convenience this op flips). A line is `shipped` once
// its cumulative shipped quantity (across `shipped`/`delivered` fulfillments) reaches
// the ordered quantity, else `partially-shipped`; the order axis is `shipped` iff every
// line is fully shipped, else `partially-shipped`.
@Injectable()
export class ShipFulfillmentUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY)
    private readonly paymentGateway: IPaymentGatewayPort,
    @Inject(ORDER_COMMIT_SALE_GATEWAY)
    private readonly commitSaleGateway: IOrderCommitSaleGatewayPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @Inject(ORDER_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IOrderCustomerContactReaderPort,
    @InjectPinoLogger(ShipFulfillmentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailFulfillmentShipPayload): Promise<FulfillmentView> {
    const {
      orderId,
      fulfillmentId,
      trackingNumber,
      carrier,
      idempotencyKey,
      actorId,
      isStaffFulfill,
      correlationId,
    } = payload;

    this.logger.info(
      { correlationId, orderId, fulfillmentId, actorId, isStaffFulfill, idempotencyKey },
      'Shipping fulfillment',
    );

    // Owner-or-staff authorization + existence (404 missing / 403 non-owner-non-staff).
    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffFulfill);

    // Load the fulfillment + assert it is shippable: it must belong to this order and
    // be `pending` (a non-`pending` re-ship is a 409 — the `Idempotency-Key` rides
    // accepted-not-deduped, and Commit Sale's `fulfillmentId` idempotency covers a
    // genuine retry inventory-side regardless).
    const fulfillment = await this.fulfillmentRepository.findById(fulfillmentId);
    if (fulfillment?.orderId !== orderId) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND,
        `Fulfillment ${fulfillmentId} not found on order ${orderId}`,
      );
    }
    if (fulfillment.status !== FulfillmentStatusEnum.PENDING) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
        `Fulfillment ${fulfillmentId} is ${fulfillment.status} and cannot be shipped`,
      );
    }

    // Validate the tracking-on-ship policy BEFORE the out-of-process capture, so the
    // ship is never blocked AFTER taking the money (the domain `ship` is still the
    // authority — this is the same check, hoisted to avoid a capture-then-fail hole).
    if (typeof trackingNumber !== 'string' || trackingNumber.trim().length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_TRACKING_REQUIRED,
        'A tracking number is required to ship a fulfillment',
      );
    }

    const payment = await this.paymentRepository.findByOrderId(orderId);
    if (!payment) {
      // A fulfillable order was authorized-on-place, so a missing payment is an
      // invariant breach — there is nothing to capture (409).
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
        `Order ${orderId} has no payment to capture on ship`,
      );
    }

    // Ship-triggered capture (Q5), BEFORE the local commit. A decline blocks the ship.
    const capture = await this.captureIfNeeded(payment, orderId, correlationId);

    const shippedAt = new Date();

    // Local transaction: advance the fulfillment → shipped, record the capture on the
    // Payment + order's payment axis (when one happened), flip the shipped lines, and
    // advance the order's fulfillment axis — atomically. Returns the persisted shipped
    // fulfillment so the post-commit steps run on concrete ids.
    const shippedFulfillment = await this.transactionPort.runInTransaction<Fulfillment>(
      async (scope) => {
        // Re-read the fulfillment under a pessimistic write lock — the first statement in
        // the transaction, so a concurrent Cancel of the same order serialises here: if
        // the Cancel committed first, this CURRENT read observes the now-`cancelled`
        // fulfillment and `fresh.ship()` below rejects it (the
        // single-writer-per-status-transition guard, ADR-031); if this Ship wins, the
        // Cancel blocks on the lock until this commits and then sees the `shipped` status.
        const fresh = await this.fulfillmentRepository.findByIdForUpdate(fulfillmentId, scope);
        if (!fresh) {
          throw new OrderDomainException(
            OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND,
            `Fulfillment ${fulfillmentId} vanished while shipping`,
          );
        }
        // The domain enforces the state guard + tracking-on-ship (the authority); under
        // the lock the guard now sees a concurrent transition (a non-`pending` status →
        // FULFILLMENT_INVALID_STATUS_TRANSITION).
        fresh.ship({ trackingNumber, carrier: carrier ?? null, shippedAt });
        const shipped = await this.fulfillmentRepository.save(fresh, scope);

        if (capture.capturedAt) {
          payment.capture(capture.capturedAt);
          await this.paymentRepository.save(payment, scope);
        }

        const freshOrder = await this.orderRepository.findById(orderId, scope);
        if (!freshOrder) {
          throw new OrderDomainException(
            OrderErrorCodeEnum.ORDER_NOT_FOUND,
            `Order ${orderId} vanished while shipping`,
          );
        }
        if (capture.capturedAt) {
          freshOrder.markPaymentCaptured();
        }

        // Roll-up: sum each order line's shipped quantity across the order's
        // `shipped`/`delivered` fulfillments (the just-shipped one is now `shipped` and
        // included) — a `pending` sibling is planned but NOT shipped, so it must not
        // count toward the roll-up.
        const fulfillments = await this.fulfillmentRepository.listByOrderId(orderId, scope);
        const shippedByLine = sumLineQuantitiesByOrderLine(fulfillments, countsTowardShipped);

        const next = ShipFulfillmentUseCase.advanceLinesAndRollUp(freshOrder, shippedByLine);
        freshOrder.advanceFulfillment(next);
        await this.orderRepository.save(freshOrder, scope);

        return shipped;
      },
    );

    // AFTER the local commit: physically decrement the inventory. Retried on failure;
    // a hard failure is logged for operator replay and does NOT roll the ship back.
    await this.commitSaleWithRetry(
      this.buildCommitSalePayload(order, shippedFulfillment, actorId, correlationId),
      correlationId,
    );

    // Resolve the buyer's email so the shipment-confirmation consumer has a recipient
    // without a per-delivery RPC (ADR-033). Best-effort: a tombstoned/missing customer or a
    // reader hiccup yields `null` (the helper never throws).
    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      order.customerId,
      this.logger,
      correlationId,
    );

    // Best-effort post-commit emits (ADR-020): always the shipped event, plus the
    // captured event only when THIS ship took the money.
    await this.emitShipped(shippedFulfillment, customerEmail, correlationId);
    if (capture.capturedAt) {
      await this.emitCaptured(order, payment, idempotencyKey, correlationId);
    }

    this.logger.info(
      { correlationId, orderId, fulfillmentId, didCapture: capture.capturedAt !== null },
      'Fulfillment shipped',
    );
    return toFulfillmentView(shippedFulfillment);
  }

  // Ship-triggered capture (Q5). An `authorized` payment is captured out-of-process
  // (outside the tx); a decline blocks the ship. An already-`captured` payment skips
  // the gateway (an explicit capture happened earlier). Any other state cannot be
  // captured.
  private async captureIfNeeded(
    payment: Payment,
    orderId: number,
    correlationId: string,
  ): Promise<ICaptureOutcome> {
    if (payment.status === PaymentStatusEnum.CAPTURED) {
      this.logger.info(
        { correlationId, orderId, paymentId: payment.id },
        'Payment already captured — skipping the gateway capture on ship',
      );
      return { capturedAt: null };
    }
    if (payment.status !== PaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment for order ${orderId} cannot be captured from status ${payment.status}`,
      );
    }

    const result = await this.paymentGateway.capture(payment.gatewayReference, correlationId);
    if (!result.captured) {
      // Block-ship-until-payment-succeeds: nothing was written, so the ship simply
      // aborts and an operator retries once the payment problem is resolved.
      this.logger.warn(
        { correlationId, orderId },
        'Payment gateway declined capture — blocking the ship',
      );
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_PAYMENT_NOT_CAPTURED,
        `Payment capture was declined for order ${orderId}; the ship is blocked until payment succeeds`,
      );
    }
    return { capturedAt: result.capturedAt };
  }

  // Flips each order line's status from its shipped-vs-ordered quantity and returns the
  // order-axis roll-up: `shipped` iff EVERY line is fully shipped, else
  // `partially-shipped`. A line with no shipped units stays `ALLOCATED` (its
  // `markFulfillment` is not called). At least one line just shipped, so the result is
  // never `unfulfilled`.
  private static advanceLinesAndRollUp(
    order: Order,
    shippedByLine: Map<number, number>,
  ): OrderFulfillmentStatusEnum {
    let everyLineFullyShipped = true;
    for (const line of order.lines) {
      const shipped = shippedByLine.get(line.id!) ?? 0;
      if (shipped >= line.quantity) {
        line.markFulfillment(OrderLineStatusEnum.SHIPPED);
      } else if (shipped > 0) {
        line.markFulfillment(OrderLineStatusEnum.PARTIALLY_SHIPPED);
        everyLineFullyShipped = false;
      } else {
        everyLineFullyShipped = false;
      }
    }
    return everyLineFullyShipped
      ? OrderFulfillmentStatusEnum.SHIPPED
      : OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED;
  }

  // Builds the Commit Sale payload from the shipped fulfillment's lines: each carries
  // the `variantId` from the order line snapshot, the fulfillment's `stockLocationId`
  // (always concrete — Create defaulted it), and the shipped quantity.
  private buildCommitSalePayload(
    order: Order,
    fulfillment: Fulfillment,
    actorId: string,
    correlationId: string,
  ): ICommitSalePayload {
    const variantByLine = new Map<number, number>();
    for (const line of order.lines) {
      variantByLine.set(line.id!, line.variantId);
    }
    return {
      orderId: order.id!,
      // `fulfillmentId` is the ledger idempotency anchor inventory-side; the wire
      // contract types it as a string.
      fulfillmentId: String(fulfillment.id),
      lines: fulfillment.lines.map((line) => ({
        variantId: variantByLine.get(line.orderLineId)!,
        stockLocationId: fulfillment.stockLocationId,
        quantity: line.quantity,
      })),
      actorId,
      correlationId,
    };
  }

  // Calls Commit Sale after the local commit, retrying a bounded number of times. On a
  // persistent failure it logs the full payload at `error` (a poison record for
  // operator replay — Commit Sale is idempotent on `fulfillmentId`, so the replay is
  // safe) and returns WITHOUT throwing: the local ship is already committed and must
  // not be rolled back (eventual consistency on the inventory decrement, ADR-031).
  private async commitSaleWithRetry(
    payload: ICommitSalePayload,
    correlationId: string,
  ): Promise<void> {
    await retryThenLogForReplay(() => this.commitSaleGateway.commitSale(payload), {
      maxAttempts: COMMIT_SALE_MAX_ATTEMPTS,
      logger: this.logger,
      correlationId,
      label: 'Commit Sale',
      context: {
        orderId: payload.orderId,
        fulfillmentId: payload.fulfillmentId,
        lines: payload.lines,
      },
      replayMessage:
        'Commit Sale failed after retries; the ship is committed and the inventory decrement awaits operator replay (idempotent on fulfillmentId)',
    });
  }

  // Best-effort, post-commit (ADR-020). The ship has already committed, so a publish
  // failure is warn-logged and swallowed. `customerEmail` is the buyer's resolved contact
  // (or `null`); `customerLocale` ships `null` (locale resolution deferred).
  private async emitShipped(
    fulfillment: Fulfillment,
    customerEmail: string | null,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishFulfillmentShipped({
        orderId: fulfillment.orderId,
        fulfillmentId: fulfillment.id!,
        customerEmail,
        customerLocale: null,
        trackingNumber: fulfillment.trackingNumber!,
        carrier: fulfillment.carrier,
        shippedAt: (fulfillment.shippedAt ?? new Date()).toISOString(),
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, fulfillmentId: fulfillment.id },
        'Failed to publish retail.fulfillment.shipped (ship already committed)',
      );
    }
  }

  // Reuses the `retail.payment.captured` event the explicit Capture Payment flow emits
  // — a ship-triggered capture is still a capture. Best-effort, post-commit.
  private async emitCaptured(
    order: Order,
    payment: Payment,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishPaymentCaptured({
        orderId: order.id!,
        paymentId: payment.id!,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        eventVersion: 'v1',
        occurredAt: (payment.capturedAt ?? new Date()).toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, orderId: order.id, idempotencyKey },
        'Failed to publish retail.payment.captured (ship already committed)',
      );
    }
  }
}
