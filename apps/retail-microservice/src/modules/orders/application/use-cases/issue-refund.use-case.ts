import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { bodyFingerprint } from '@retail-inventory-system/common';
import {
  AUDIT_LOG_PUBLISHER,
  IAuditLogPublisher,
  IIdempotentResult,
  IRetailRefundIssuePayload,
  PaymentStatusEnum,
  RefundStatusEnum,
  RefundView,
} from '@retail-inventory-system/contracts';

import { OrderDomainException, OrderErrorCodeEnum, Payment, Refund } from '../../domain';
import {
  IIdempotencyStorePort,
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  IRefundRepositoryPort,
  ITransactionPort,
  IDEMPOTENCY_STORE,
  ORDER_CUSTOMER_CONTACT_READER,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
  REFUND_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { toRefundView } from './refund-view.factory';
import { resolveCustomerEmail } from './resolve-customer-email';

// A before/after snapshot of the captured payment, recorded on the audit row so an
// auditor can see exactly what the refund moved.
interface IPaymentSnapshot {
  status: PaymentStatusEnum;
  refundedAmountMinor: number;
}

// Issue Refund returns money for a captured payment (ADR-032). It is the one use case
// behind **both** refund paths — the manual staff-initiated endpoint (over
// `retail.refund.issue`) and the auto-refund-from-cancel consumer (which calls
// `execute(...)` directly, not over RMQ) — so the preconditions, the accounting, the
// audit, and the events live in exactly one place.
//
// **Authorization is staff-only** (`order:refund`), enforced at the gateway with
// `@RequiresPermission`; this use case trusts the resolved `actorId` and does no
// owner-check (the manual endpoint is staff-gated, and the auto path is system-driven).
//
// **Preconditions**: the payment must be `CAPTURED` (`REFUND_PAYMENT_NOT_CAPTURED` — only
// captured money can be reversed), and the requested amount must fit the **refundable
// ceiling** `payment.amountMinor − payment.refundedAmountMinor` (`REFUND_EXCEEDS_REFUNDABLE`).
//
// **Two idempotency layers (ADR-036 + ADR-032).** First the request-level
// `Idempotency-Key`, enforced **reserve-first** (the concurrency hardening): `execute`
// fingerprints the canonical body (`bodyFingerprint`) and atomically **reserves**
// `(scope='issue-refund', key)` in the `IDEMPOTENCY_STORE` — an INSERT of a *pending* row —
// BEFORE the gateway call. Unlike place/capture/ship (each serialized by a second guard —
// the cart-conversion CAS / payment-state + order OCC / `SELECT … FOR UPDATE`), refund has
// none and the gateway refund is not naturally idempotent, so a `find → refund → save` flow
// would let two truly concurrent same-key submits BOTH refund. Reserve-first turns the loser
// away: a same-key/same-body hit on a **completed** row **replays the stored `RefundView`
// before any side effect — and, crucially, before the audit emit** (a replay must not write a
// second `audit_log_entry`); a same-key/*different*-body hit → `422`; a same-key submit that
// races a still-**in-flight** one → `409` (`ORDER_IDEMPOTENCY_KEY_IN_PROGRESS`), turned away
// before it can refund a second time; a missing key → `400` backstop (the manual gateway
// route + the auto-refund-from-cancel consumer both supply a key — the consumer a
// deterministic one). Second, the **natural idempotency** remains the backstop (ADR-032):
// an `issued` refund for the same `(paymentId, amountMinor, reason)` short-circuits to its
// existing view, making **no** second gateway call. It runs *before* the captured-
// precondition so a **full**-refund replay (the payment is now `refunded`, not `captured`)
// is still idempotent rather than rejected. Combined with the `refunded_amount_minor`
// ceiling, a replay can never over-refund. The key-store check is first; the refundable
// ceiling remains the backstop.
//
// **The gateway `refund` call is out-of-process**, so it runs outside the DB transaction
// (the capture-payment precedent); only the two writes that follow — accumulate the
// `Payment` (`refund(amountMinor)` → `refunded_amount_minor` + the partial-vs-full status
// flip) and walk the `Refund` to `issued` — run together in a short follow-up transaction.
// A gateway **decline** (unreachable with the always-succeed fake, modeled) walks the
// `Refund` to `failed`, leaves the `Payment` untouched, and returns the failed view.
//
// **Refunds are always audited** (the cross-cutting money-movements rule, ADR-032): the
// audit row is written retail-side here, with the actor / amount / reason / a before-after
// `Payment` snapshot — so it covers the auto-refund path too (which never reaches a gateway
// endpoint). A store replay short-circuits before this audit — one logical refund writes
// exactly one audit row regardless of how many times the client retries.
@Injectable()
export class IssueRefundUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(PAYMENT_GATEWAY)
    private readonly paymentGateway: IPaymentGatewayPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(REFUND_REPOSITORY)
    private readonly refundRepository: IRefundRepositoryPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @Inject(ORDER_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IOrderCustomerContactReaderPort,
    @Inject(AUDIT_LOG_PUBLISHER)
    private readonly audit: IAuditLogPublisher,
    @Inject(IDEMPOTENCY_STORE)
    private readonly idempotencyStore: IIdempotencyStorePort,
    @InjectPinoLogger(IssueRefundUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  // The scope namespaces the client key by operation, so the same `Idempotency-Key`
  // reused across two operations cannot collide in the store (ADR-036).
  private static readonly SCOPE = 'issue-refund';

  public async execute(payload: IRetailRefundIssuePayload): Promise<IIdempotentResult<RefundView>> {
    const { idempotencyKey, correlationId, orderId, paymentId } = payload;

    // Defensive backstop for the gateway's required-header edge check. Both callers supply
    // a key: the manual endpoint forwards the client header, and the auto-refund-from-cancel
    // consumer synthesizes a deterministic one — so this fires only for a raw gateway-bypass
    // caller (ADR-036).
    if (!idempotencyKey) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key is required to issue a refund',
      );
    }

    // Fingerprint the CANONICAL body — the client-controlled refund command minus
    // transport/identity noise (`correlationId`, `idempotencyKey`, and the resolved
    // `actorId`), so a retry under a fresh correlation id still matches (ADR-036).
    const fingerprint = bodyFingerprint(IssueRefundUseCase.canonicalBody(payload));

    // RESERVE-FIRST (ADR-036 concurrency hardening). Refund is the one idempotent write with
    // no *second* serializing guard (place has the cart-conversion CAS, capture the
    // payment-state + order OCC, ship the `SELECT … FOR UPDATE`), and the gateway refund is
    // not naturally idempotent — so a `find → refund → save` flow would let two truly
    // concurrent same-key submits BOTH refund before either records the key. Instead, an
    // atomic INSERT of a *pending* row claims `(scope, key)` BEFORE the gateway call:
    //  - `replay`      — a completed row with a matching fingerprint already exists: return
    //                    the stored `RefundView` WITHOUT the gateway, the audit, or the emit.
    //  - `mismatch`    — one key reused for a different body → `422`.
    //  - `in-progress` — a concurrent submit holds the key and is mid-refund → `409`; the
    //                    client retries once it completes and then replays the result.
    //  - `reserved`    — this call won the INSERT and owns the execution (below).
    const reservation = await this.idempotencyStore.reserve({
      scope: IssueRefundUseCase.SCOPE,
      key: idempotencyKey,
      requestFingerprint: fingerprint,
    });

    if (reservation.outcome === 'replay') {
      this.logger.debug(
        { correlationId, orderId, paymentId, idempotencyKey },
        'Idempotent replay — returning the stored refund response (no gateway, no audit, no events)',
      );
      return { view: reservation.record!.responseBody as unknown as RefundView, replayed: true };
    }
    if (reservation.outcome === 'mismatch') {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REUSED,
        `Idempotency-Key ${idempotencyKey} was already used for an issue-refund request with a different body`,
      );
    }
    if (reservation.outcome === 'in-progress') {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_IN_PROGRESS,
        `Idempotency-Key ${idempotencyKey} is already being processed for a concurrent issue-refund request`,
      );
    }

    // `reserved` — this call OWNS the execution. Run the refund (the natural already-issued
    // short-circuit + the refundable ceiling still apply inside; a declined refund returns a
    // `failed` view, not a throw). On ANY failure release the reservation so a legitimate
    // retry can re-run — the natural already-issued guard remains the backstop for the rare
    // gateway-succeeded-then-crashed window (unchanged by this hardening).
    let view: RefundView;
    try {
      view = await this.issue(payload);
    } catch (error) {
      await this.releaseReservation(idempotencyKey, correlationId);
      throw error;
    }

    // Finalize the reserved row with the captured response so the next identical retry
    // replays. If finalize fails the refund has already committed — release the pending row
    // so a retry is not blocked with `in-progress` (the retry re-runs and the natural
    // already-issued guard returns THIS refund, no second gateway call), and still return
    // the successful view.
    try {
      await this.idempotencyStore.finalize({
        scope: IssueRefundUseCase.SCOPE,
        key: idempotencyKey,
        // The refund route is `201 Created`; the gateway forces `200` on any replay.
        responseStatus: HttpStatus.CREATED,
        responseBody: view as unknown as Record<string, unknown>,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, orderId, paymentId, idempotencyKey },
        'Failed to finalize the idempotency record after a committed refund; releasing the reservation for a safe retry',
      );
      await this.releaseReservation(idempotencyKey, correlationId);
    }

    return { view, replayed: false };
  }

  // Releases the reservation this call took, best-effort: a failed release leaves a pending
  // row the TTL purge reclaims, and the natural already-issued guard keeps a retry safe
  // regardless — so a release hiccup never blocks the refund from returning.
  private async releaseReservation(idempotencyKey: string, correlationId: string): Promise<void> {
    try {
      await this.idempotencyStore.release(IssueRefundUseCase.SCOPE, idempotencyKey);
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, idempotencyKey },
        'Failed to release the idempotency reservation (will be reclaimed by the TTL purge)',
      );
    }
  }

  // Builds the stable logical body the fingerprint covers: the client-controlled refund
  // command. The resolved `actorId` (a session property) and the transport `correlationId` /
  // `idempotencyKey` are excluded, so the same intent under a fresh correlation id
  // fingerprints identically (ADR-036). `paymentId` is included — a reuse of one key for a
  // refund against a different payment is a key-reuse bug (`422`), not a replay.
  private static canonicalBody(payload: IRetailRefundIssuePayload): Record<string, unknown> {
    return {
      orderId: payload.orderId,
      paymentId: payload.paymentId,
      amountMinor: payload.amountMinor,
      reason: payload.reason,
    };
  }

  // The refund flow proper (run on a store miss): the not-found guards, the natural
  // already-issued short-circuit, the captured + refundable-ceiling preconditions, the
  // out-of-process gateway refund, the short follow-up transaction, the always-audit money
  // movement, and the post-commit emit. Returns the `RefundView` (`issued` or `failed`).
  private async issue(payload: IRetailRefundIssuePayload): Promise<RefundView> {
    const { orderId, paymentId, amountMinor, reason, actorId, idempotencyKey, correlationId } =
      payload;

    this.logger.info(
      { correlationId, orderId, paymentId, amountMinor, actorId, idempotencyKey },
      'Issuing refund',
    );

    // The order anchors the audit context + the refund currency; the payment is the money
    // being reversed. Both are always needed on the success path and neither read depends
    // on the other, so fetch them in one parallel round-trip rather than two sequential
    // ones — this is the hot path for both the endpoint and the auto-refund-from-cancel
    // consumer. The not-found guards still run in order below, preserving error precedence.
    const [order, payment] = await Promise.all([
      this.orderRepository.findById(orderId),
      this.paymentRepository.findById(paymentId),
    ]);

    // A missing order is a data-integrity breach (a payment's `order_id` FK guarantees
    // one) — 404. Checked first so it wins precedence over the payment guards.
    if (!order) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FOUND,
        `Order ${orderId} not found`,
      );
    }

    // A missing payment, or one belonging to another order, means there is no captured
    // payment for this order to refund — the clearest code is the not-captured one. Two
    // guards (not `!payment || payment.orderId !== orderId`) so the type narrows cleanly.
    if (payment === null) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_PAYMENT_NOT_CAPTURED,
        `Order ${orderId} has no payment ${paymentId} to refund`,
      );
    }
    if (payment.orderId !== orderId) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_PAYMENT_NOT_CAPTURED,
        `Payment ${paymentId} does not belong to order ${orderId}`,
      );
    }

    // Natural-idempotency short-circuit — runs before the captured-precondition so a
    // full-refund replay (payment now `refunded`) returns the existing refund instead of
    // a `REFUND_PAYMENT_NOT_CAPTURED`. No gateway call, no new row.
    const duplicate = await this.findIssuedDuplicate(paymentId, amountMinor, reason);
    if (duplicate) {
      this.logger.info(
        { correlationId, orderId, paymentId, refundId: duplicate.id },
        'Refund already issued for this (payment, amount, reason) — returning it (idempotent)',
      );
      return toRefundView(duplicate);
    }

    // Precondition: only captured money can be reversed.
    if (payment.status !== PaymentStatusEnum.CAPTURED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_PAYMENT_NOT_CAPTURED,
        `Payment ${paymentId} is ${payment.status}, not captured — nothing to refund`,
      );
    }

    // Precondition: the refundable ceiling. `refunded_amount_minor` is the source of truth
    // for how much is already refunded; a request beyond the remainder is rejected, so a
    // replay (or a too-large request) can never over-refund.
    const refundable = payment.amountMinor - payment.refundedAmountMinor;
    if (amountMinor > refundable) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_EXCEEDS_REFUNDABLE,
        `Refund of ${amountMinor} exceeds the refundable remainder ${refundable} for payment ${paymentId}`,
      );
    }

    // Snapshot the payment before any mutation, for the audit before/after.
    const before: IPaymentSnapshot = {
      status: payment.status,
      refundedAmountMinor: payment.refundedAmountMinor,
    };

    // Open the `Refund` PENDING and persist it before calling the gateway, so a row exists
    // even if the process dies mid-gateway-call.
    const pendingRefund = await this.refundRepository.save(
      Refund.open({ orderId, paymentId, amountMinor, currency: order.currency, reason }),
    );

    // Out-of-process gateway call — deliberately outside the DB transaction.
    const result = await this.paymentGateway.refund({
      gatewayReference: payment.gatewayReference,
      amountMinor,
      currency: order.currency,
      correlationId,
    });

    if (!result.refunded) {
      return this.handleDecline(payload, payment, pendingRefund, before);
    }

    // Short follow-up transaction: accumulate the payment + walk the refund to issued,
    // atomically. The mutated `payment` reflects the post-refund state in memory after.
    const issuedRefund = await this.transactionPort.runInTransaction<Refund>(async (scope) => {
      payment.refund(amountMinor);
      await this.paymentRepository.save(payment, scope);

      pendingRefund.markIssued({
        gatewayReference: result.gatewayReference,
        issuedAt: result.refundedAt,
      });
      return this.refundRepository.save(pendingRefund, scope);
    });

    const after: IPaymentSnapshot = {
      status: payment.status,
      refundedAmountMinor: payment.refundedAmountMinor,
    };
    // Resolve the buyer's email from the refund's ORDER (the refund event carries no
    // customerId of its own) so the refund-confirmation consumer has a recipient without a
    // per-delivery RPC (ADR-033). Best-effort: a tombstoned/missing customer or a reader
    // hiccup yields `null` (the helper never throws).
    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      order.customerId,
      this.logger,
      correlationId,
    );

    await this.writeAudit('RefundIssued', issuedRefund, payload, before, after);
    await this.emitIssued(issuedRefund, customerEmail, correlationId);

    this.logger.info(
      { correlationId, orderId, paymentId, refundId: issuedRefund.id, paymentStatus: after.status },
      'Refund issued',
    );
    return toRefundView(issuedRefund);
  }

  // The gateway declined (unreachable with the fake, modeled). Walk the refund to
  // `failed`, leave the payment untouched, audit the attempt, and emit the failed event.
  private async handleDecline(
    payload: IRetailRefundIssuePayload,
    payment: Payment,
    pendingRefund: Refund,
    before: IPaymentSnapshot,
  ): Promise<RefundView> {
    pendingRefund.markFailed();
    const failedRefund = await this.refundRepository.save(pendingRefund);

    const failureReason = 'Payment gateway declined the refund';
    this.logger.warn(
      { correlationId: payload.correlationId, orderId: payload.orderId, refundId: failedRefund.id },
      failureReason,
    );

    // The payment is unchanged, so before === after.
    const after: IPaymentSnapshot = {
      status: payment.status,
      refundedAmountMinor: payment.refundedAmountMinor,
    };
    await this.writeAudit('RefundFailed', failedRefund, payload, before, after);
    await this.emitFailed(failedRefund, failureReason, payload.correlationId);

    return toRefundView(failedRefund);
  }

  // The already-issued dedupe match: an `issued` refund for the same payment, amount, and
  // reason. `findByPaymentId` returns the payment's refunds newest-first.
  private async findIssuedDuplicate(
    paymentId: number,
    amountMinor: number,
    reason: string,
  ): Promise<Refund | null> {
    const existing = await this.refundRepository.findByPaymentId(paymentId);
    return (
      existing.find(
        (refund) =>
          refund.status === RefundStatusEnum.ISSUED &&
          refund.amountMinor === amountMinor &&
          refund.reason === reason,
      ) ?? null
    );
  }

  // The always-audit money-movement record (ADR-032/035). Awaited (not best-effort) —
  // auditing is integral to a refund; the bound `AuditLogRabbitmqPublisher` swallows its own
  // broker failures (warn-log, never rethrow per ADR-020), so the await never blocks the
  // refund. No `targetKind` member fits an order/payment/refund, so the ids ride the
  // structured payload and `targetKind` stays null.
  private async writeAudit(
    name: 'RefundIssued' | 'RefundFailed',
    refund: Refund,
    payload: IRetailRefundIssuePayload,
    before: IPaymentSnapshot,
    after: IPaymentSnapshot,
  ): Promise<void> {
    await this.audit.publish({
      name,
      actorId: payload.actorId,
      // Refunds are staff-gated (`order:refund`); the auto-refund-from-cancel path also
      // routes through here with a **system** actor (`actorId` null). Either way it is a
      // privileged money movement, audited as `staff` (the audit actor-kind union has no
      // dedicated `system` member; the null `actorId` already signals the system origin).
      actorKind: 'staff',
      targetId: String(payload.orderId),
      targetKind: null,
      payload: {
        orderId: payload.orderId,
        paymentId: payload.paymentId,
        refundId: refund.id,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        reason: refund.reason,
        idempotencyKey: payload.idempotencyKey ?? null,
        paymentStatusBefore: before.status,
        paymentStatusAfter: after.status,
        refundedAmountMinorBefore: before.refundedAmountMinor,
        refundedAmountMinorAfter: after.refundedAmountMinor,
      },
      correlationId: payload.correlationId,
    });
  }

  // Best-effort, post-commit (ADR-020). The refund has already committed, so a publish
  // failure is warn-logged and swallowed. `customerEmail` is the buyer's resolved contact (or
  // `null`); `customerLocale` ships `null` (locale resolution deferred).
  private async emitIssued(
    refund: Refund,
    customerEmail: string | null,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishRefundIssued({
        refundId: refund.id!,
        orderId: refund.orderId,
        paymentId: refund.paymentId,
        customerEmail,
        customerLocale: null,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        issuedAt: (refund.issuedAt ?? new Date()).toISOString(),
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, refundId: refund.id },
        'Failed to publish retail.refund.issued (refund already committed)',
      );
    }
  }

  private async emitFailed(
    refund: Refund,
    failureReason: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishRefundFailed({
        refundId: refund.id!,
        orderId: refund.orderId,
        paymentId: refund.paymentId,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        failureReason,
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, refundId: refund.id },
        'Failed to publish retail.refund.failed',
      );
    }
  }
}
