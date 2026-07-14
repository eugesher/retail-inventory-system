import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailOrderCancelledEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IPaymentRepositoryPort, PAYMENT_REPOSITORY } from '../../application/ports';
import { IssueRefundUseCase } from '../../application/use-cases';

// RMQ subscriber that closes the cancellation→refund loop. Cancel Order (ADR-031) settles
// a **captured** payment on cancellation by setting `payment.flagged_for_refund=true` and
// emitting `retail.order.cancelled` with `paymentFlaggedForRefund` — but it does **not**
// move the money (it commits the cancel first, then leaves the refund to a consumer). This
// consumer is that consumer: it reads retail's **own** `retail.order.cancelled` off
// `retail_queue` and, when the flag is set, issues a **full** refund for the order's
// captured payment by invoking `IssueRefundUseCase` **inline** (ADR-032).
//
// **Inline, not a separate worker** (ADR-018): the use case already owns the preconditions,
// the gateway call, the `Payment.refund()` accounting, the audit, and the events — calling
// it directly (not back over RMQ) reuses all of that with no cross-service hop and no new
// deployable. A thin infrastructure adapter (ADR-011 §4): it decides *whether* and *how
// much* to refund, then delegates the *how* to the use case.
//
// **Idempotency without a job table** (ADR-020 at-least-once delivery): there is no
// processed-message store — the **refundable-amount guard** *is* the idempotency, and it falls
// straight out of the payment-row accounting. Once the capture is fully refunded,
// `refundedAmountMinor === amountMinor`, so a redelivery computes `refundable === 0` and no-ops
// before any gateway call. Two further layers back that up: `IssueRefundUseCase`'s own
// already-issued short-circuit, and the request-level store (ADR-036), which replays a
// *sequential* redelivery and turns a *concurrent* one away with
// `ORDER_IDEMPOTENCY_KEY_IN_PROGRESS` — a **throw**, which the best-effort catch below
// swallows. The flag stays the durable retry anchor.
//
// **Best-effort** (the flag is the durable retry anchor): a downstream failure is
// warn-logged and swallowed so the handler never throws. The cancel has already committed,
// and a failed auto-refund leaves the payment `flagged_for_refund` — exactly the flag's
// purpose: a later manual refund (or a redelivery) can still settle the money.
@Controller()
export class OrderCancelledConsumer {
  constructor(
    private readonly issueRefund: IssueRefundUseCase,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @InjectPinoLogger(OrderCancelledConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.RETAIL_ORDER_CANCELLED)
  public async onOrderCancelled(@Payload() event: IRetailOrderCancelledEvent): Promise<void> {
    const { orderId, paymentFlaggedForRefund, correlationId } = event;

    // A pre-capture cancellation voided the authorization (or there was no payment) — no
    // money was ever taken, so there is nothing to refund. `@EventPattern` handlers are not
    // request-scoped, so `correlationId` rides inline (`PinoLogger.assign` would throw —
    // ADR-011 §7).
    if (paymentFlaggedForRefund !== true) {
      this.logger.debug(
        { correlationId, orderId },
        'Order cancelled without a captured payment flagged for refund — nothing to auto-refund',
      );
      return;
    }

    try {
      await this.autoRefund(orderId, correlationId);
    } catch (error) {
      // Best-effort: the cancel already committed, and the payment stays
      // `flagged_for_refund` for a later manual refund or a redelivery. Swallow + warn so a
      // downstream hiccup never throws out of the handler (a throw would NACK/redeliver to
      // no benefit — the guard makes a redelivery a no-op once refunded).
      this.logger.warn(
        { err: error as Error, correlationId, orderId },
        'Auto-refund from cancel failed — payment stays flagged for refund (manual retry)',
      );
    }
  }

  private async autoRefund(orderId: number, correlationId: string): Promise<void> {
    const payment = await this.paymentRepository.findByOrderId(orderId);
    if (!payment) {
      // The flag asserts a captured payment existed; if the row is gone there is nothing to
      // act on. Warn (a data-integrity surprise) and stop.
      this.logger.warn(
        { correlationId, orderId },
        'Order flagged for refund but has no payment row — skipping auto-refund',
      );
      return;
    }

    // The refundable remainder is the idempotency anchor (see the class comment). A
    // fully-refunded payment computes `0` here, so a redelivery short-circuits before any
    // gateway call.
    const refundable = payment.amountMinor - payment.refundedAmountMinor;
    if (refundable <= 0) {
      this.logger.info(
        { correlationId, orderId, paymentId: payment.id },
        'Cancelled order already fully refunded — auto-refund is a no-op (idempotent redelivery)',
      );
      return;
    }

    this.logger.info(
      { correlationId, orderId, paymentId: payment.id, amountMinor: refundable },
      'Auto-refunding cancelled order for the full refundable remainder',
    );

    // Delegate the actual refund to the shared use case. `actorId: null` marks the
    // system-initiated origin (no human caller); `reason: 'order-cancelled'` records why on
    // the `refund` row + the audit log. The use case re-checks captured + ceiling + the
    // already-issued idempotency, so a racing duplicate is also safe.
    //
    // The `IssueRefundUseCase` now requires an `Idempotency-Key` (ADR-036 — the manual
    // endpoint supplies the client header). The system path has no client key, so it
    // synthesizes a **deterministic** one from `(orderId, paymentId)`: there is at most one
    // auto-refund per cancelled order, so a redelivered `retail.order.cancelled` collapses to
    // a store replay rather than a second refund. This layers exact-replay on top of the
    // refundable-remainder guard (which already no-ops a redelivery once fully refunded).
    await this.issueRefund.execute({
      orderId,
      paymentId: payment.id!,
      amountMinor: refundable,
      reason: 'order-cancelled',
      actorId: null,
      idempotencyKey: `order-cancelled:${orderId}:${payment.id}`,
      correlationId,
    });
  }
}
