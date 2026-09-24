import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { bodyFingerprint } from '@retail-inventory-system/common';
import {
  IIdempotentResult,
  IRetailPaymentCapturePayload,
  OrderView,
  PaymentStatusEnum,
} from '@retail-inventory-system/contracts';

import { Order, OrderDomainException, OrderErrorCodeEnum, Payment } from '../../domain';
import {
  IIdempotencyStorePort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  IDEMPOTENCY_STORE,
  OCC_RETRY_ATTEMPTS,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { loadAuthorizedOrder } from './order-access';
import { runWithOrderWriteRetry } from './order-write';
import { toOrderView } from './order-view.factory';

class AlreadyCapturedSignal extends Error {
  constructor() {
    super('Payment was captured by a concurrent caller while this capture was claiming it');
    this.name = 'AlreadyCapturedSignal';
  }
}

@Injectable()
export class CapturePaymentUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(PAYMENT_GATEWAY)
    private readonly paymentGateway: IPaymentGatewayPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @Inject(IDEMPOTENCY_STORE)
    private readonly idempotencyStore: IIdempotencyStorePort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(CapturePaymentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  private static readonly SCOPE = 'capture-payment';

  public async execute(
    payload: IRetailPaymentCapturePayload,
  ): Promise<IIdempotentResult<OrderView>> {
    const { idempotencyKey, correlationId, orderId } = payload;

    if (!idempotencyKey) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key is required to capture a payment',
      );
    }

    const fingerprint = bodyFingerprint(CapturePaymentUseCase.canonicalBody(payload));

    const prior = await this.idempotencyStore.find(CapturePaymentUseCase.SCOPE, idempotencyKey);
    if (prior) {
      if (prior.requestFingerprint === fingerprint) {
        this.logger.debug(
          { correlationId, orderId, idempotencyKey },
          'Idempotent replay — returning the stored capture response (no re-execution, no events)',
        );
        return { view: prior.responseBody as unknown as OrderView, replayed: true };
      }
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REUSED,
        `Idempotency-Key ${idempotencyKey} was already used for a capture-payment request with a different body`,
      );
    }

    const view = await this.capture(payload);
    await this.idempotencyStore.save({
      scope: CapturePaymentUseCase.SCOPE,
      key: idempotencyKey,
      requestFingerprint: fingerprint,
      responseStatus: HttpStatus.OK,
      responseBody: view as unknown as Record<string, unknown>,
    });

    const stored = await this.idempotencyStore.find(CapturePaymentUseCase.SCOPE, idempotencyKey);
    if (stored && (stored.responseBody as { id?: number }).id !== view.id) {
      this.logger.debug(
        { correlationId, orderId, idempotencyKey },
        'Idempotent replay — a concurrent capture stored first; returning the winning response',
      );
      return { view: stored.responseBody as unknown as OrderView, replayed: true };
    }
    return { view, replayed: false };
  }

  private static canonicalBody(payload: IRetailPaymentCapturePayload): Record<string, unknown> {
    return {
      orderId: payload.orderId,
      amountMinor: payload.amountMinor,
    };
  }

  private async capture(payload: IRetailPaymentCapturePayload): Promise<OrderView> {
    const { orderId, actorId, isStaffCapture, amountMinor, idempotencyKey, correlationId } =
      payload;

    this.logger.info(
      { correlationId, orderId, actorId, isStaffCapture, idempotencyKey },
      'Capturing payment',
    );

    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffCapture);

    const payment = await this.paymentRepository.findByOrderId(orderId);
    if (!payment) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
        `Order ${orderId} has no authorized payment to capture`,
      );
    }

    if (payment.status === PaymentStatusEnum.CAPTURED) {
      this.logger.info(
        { correlationId, orderId, paymentId: payment.id },
        'Payment already captured — returning current state (idempotent)',
      );
      return toOrderView(order, payment);
    }

    if (payment.status !== PaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment for order ${orderId} cannot be captured from status ${payment.status}`,
      );
    }

    if (typeof amountMinor === 'number' && amountMinor !== order.grandTotalMinor) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PARTIAL_CAPTURE_UNSUPPORTED,
        `Partial capture is not supported: amountMinor ${amountMinor} must equal the order's ` +
          `grand total ${order.grandTotalMinor} (or be omitted)`,
      );
    }

    try {
      await this.transactionPort.runInTransaction(async (scope) => {
        const claimed = await this.paymentRepository.findByOrderIdForUpdate(orderId, scope);
        if (!claimed) {
          throw new OrderDomainException(
            OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
            `Order ${orderId} has no payment to capture`,
          );
        }
        if (claimed.status === PaymentStatusEnum.CAPTURED) {
          throw new AlreadyCapturedSignal();
        }
        claimed.beginCapture();
        await this.paymentRepository.save(claimed, scope);
      });
    } catch (error) {
      if (!(error instanceof AlreadyCapturedSignal)) {
        throw error;
      }
      const [winnerOrder, winnerPayment] = await Promise.all([
        this.orderRepository.findById(orderId),
        this.paymentRepository.findByOrderId(orderId),
      ]);
      if (!winnerOrder || !winnerPayment) {
        throw new Error(`CapturePaymentUseCase: order ${orderId} vanished during capture`);
      }
      this.logger.info(
        { correlationId, orderId, paymentId: winnerPayment.id },
        'Payment was captured by a concurrent caller — returning current state (idempotent, nothing charged)',
      );
      return toOrderView(winnerOrder, winnerPayment);
    }

    const result = await this.paymentGateway.capture(payment.gatewayReference, correlationId);
    if (!result.captured) {
      await this.transactionPort.runInTransaction(async (scope) => {
        const declined = await this.paymentRepository.findByOrderIdForUpdate(orderId, scope);
        declined?.releaseCapture();
        if (declined) {
          await this.paymentRepository.save(declined, scope);
        }
      });
      this.logger.warn(
        { correlationId, orderId },
        'Payment gateway declined capture — claim released, payment is authorized again',
      );
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_PAYMENT_NOT_CAPTURED,
        `Payment capture was declined for order ${orderId}`,
      );
    }

    await runWithOrderWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      () =>
        this.transactionPort.runInTransaction(async (scope) => {
          const freshPayment = await this.paymentRepository.findByOrderId(orderId, scope);
          if (!freshPayment) {
            throw new OrderDomainException(
              OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
              `Order ${orderId} has no payment to capture`,
            );
          }
          freshPayment.completeCapture(result.capturedAt);
          await this.paymentRepository.save(freshPayment, scope);

          const fresh = await this.orderRepository.findById(orderId, scope);
          if (!fresh) {
            throw new OrderDomainException(
              OrderErrorCodeEnum.ORDER_NOT_FOUND,
              `Order ${orderId} not found while capturing payment`,
            );
          }
          const versionAtLoad = fresh.version;
          fresh.markPaymentCaptured();
          await this.orderRepository.save(fresh, scope, versionAtLoad);
        }),
      { orderId, correlationId },
    );

    const [finalOrder, finalPayment] = await Promise.all([
      this.orderRepository.findById(orderId),
      this.paymentRepository.findByOrderId(orderId),
    ]);
    if (!finalOrder || !finalPayment) {
      throw new Error(`CapturePaymentUseCase: order ${orderId} vanished after capture`);
    }

    await this.emitCaptured(finalOrder, finalPayment, idempotencyKey, correlationId);

    this.logger.info({ correlationId, orderId, paymentId: finalPayment.id }, 'Payment captured');
    return toOrderView(finalOrder, finalPayment);
  }

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
        'Failed to publish retail.payment.captured (capture already committed)',
      );
    }
  }
}
