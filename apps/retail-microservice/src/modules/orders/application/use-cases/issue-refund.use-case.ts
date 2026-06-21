import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  AUDIT_LOG_PUBLISHER,
  IAuditLogPublisher,
  IRetailRefundIssuePayload,
  PaymentStatusEnum,
  RefundStatusEnum,
  RefundView,
} from '@retail-inventory-system/contracts';

import { OrderDomainException, OrderErrorCodeEnum, Payment, Refund } from '../../domain';
import {
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  IRefundRepositoryPort,
  ITransactionPort,
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
// **Natural idempotency** (ADR-032 — no persisted idempotency-key store yet): the
// `Idempotency-Key` header is accepted + logged but not deduped. The dedupe guard is the
// **already-issued match** — an `issued` refund for the same `(paymentId, amountMinor,
// reason)` short-circuits to its existing view, making **no** second gateway call. It runs
// *before* the captured-precondition so a **full**-refund replay (the payment is now
// `refunded`, not `captured`) is still idempotent rather than rejected. Combined with the
// `refunded_amount_minor` ceiling, a replay can never over-refund.
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
// endpoint).
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
    @InjectPinoLogger(IssueRefundUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailRefundIssuePayload): Promise<RefundView> {
    const { orderId, paymentId, amountMinor, reason, actorId, idempotencyKey, correlationId } =
      payload;

    // The `Idempotency-Key` is accepted + logged but NOT deduped (ADR-032).
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

  // The always-audit money-movement record (ADR-032). Awaited (not best-effort) — auditing
  // is integral to a refund; the default `NoOpAuditLogPublisher` never throws, and a real
  // sink's reliability is its own concern (the gateway login/logout precedent). No
  // `targetKind` member fits an order/payment/refund, so the ids ride the structured
  // payload and `targetKind` stays null.
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
