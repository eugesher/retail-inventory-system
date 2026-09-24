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

interface IPaymentSnapshot {
  status: PaymentStatusEnum;
  refundedAmountMinor: number;
}

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

  private static readonly SCOPE = 'issue-refund';

  public async execute(payload: IRetailRefundIssuePayload): Promise<IIdempotentResult<RefundView>> {
    const { idempotencyKey, correlationId, orderId, paymentId } = payload;

    if (!idempotencyKey) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key is required to issue a refund',
      );
    }

    const fingerprint = bodyFingerprint(IssueRefundUseCase.canonicalBody(payload));

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

    let view: RefundView;
    try {
      view = await this.issue(payload);
    } catch (error) {
      await this.releaseReservation(idempotencyKey, correlationId);
      throw error;
    }

    try {
      await this.idempotencyStore.finalize({
        scope: IssueRefundUseCase.SCOPE,
        key: idempotencyKey,
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

  private static canonicalBody(payload: IRetailRefundIssuePayload): Record<string, unknown> {
    return {
      orderId: payload.orderId,
      paymentId: payload.paymentId,
      amountMinor: payload.amountMinor,
      reason: payload.reason,
    };
  }

  private async issue(payload: IRetailRefundIssuePayload): Promise<RefundView> {
    const { orderId, paymentId, amountMinor, reason, actorId, idempotencyKey, correlationId } =
      payload;

    this.logger.info(
      { correlationId, orderId, paymentId, amountMinor, actorId, idempotencyKey },
      'Issuing refund',
    );

    const [order, payment] = await Promise.all([
      this.orderRepository.findById(orderId),
      this.paymentRepository.findById(paymentId),
    ]);

    if (!order) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FOUND,
        `Order ${orderId} not found`,
      );
    }

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

    const duplicate = await this.findIssuedDuplicate(paymentId, amountMinor, reason);
    if (duplicate) {
      this.logger.info(
        { correlationId, orderId, paymentId, refundId: duplicate.id },
        'Refund already issued for this (payment, amount, reason) — returning it (idempotent)',
      );
      return toRefundView(duplicate);
    }

    if (payment.status !== PaymentStatusEnum.CAPTURED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_PAYMENT_NOT_CAPTURED,
        `Payment ${paymentId} is ${payment.status}, not captured — nothing to refund`,
      );
    }

    const refundable = payment.amountMinor - payment.refundedAmountMinor;
    if (amountMinor > refundable) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_EXCEEDS_REFUNDABLE,
        `Refund of ${amountMinor} exceeds the refundable remainder ${refundable} for payment ${paymentId}`,
      );
    }

    const before: IPaymentSnapshot = {
      status: payment.status,
      refundedAmountMinor: payment.refundedAmountMinor,
    };

    const pendingRefund = await this.refundRepository.save(
      Refund.open({ orderId, paymentId, amountMinor, currency: order.currency, reason }),
    );

    const result = await this.paymentGateway.refund({
      gatewayReference: payment.gatewayReference,
      amountMinor,
      currency: order.currency,
      correlationId,
    });

    if (!result.refunded) {
      return this.handleDecline(payload, payment, pendingRefund, before);
    }

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

    const after: IPaymentSnapshot = {
      status: payment.status,
      refundedAmountMinor: payment.refundedAmountMinor,
    };
    await this.writeAudit('RefundFailed', failedRefund, payload, before, after);
    await this.emitFailed(failedRefund, failureReason, payload.correlationId);

    return toRefundView(failedRefund);
  }

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
