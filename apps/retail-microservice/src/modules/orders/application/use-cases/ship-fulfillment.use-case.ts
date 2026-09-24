import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { bodyFingerprint, retryThenLogForReplay } from '@retail-inventory-system/common';
import {
  FulfillmentStatusEnum,
  FulfillmentView,
  ICommitSalePayload,
  IIdempotentResult,
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
  IIdempotencyStorePort,
  IFulfillmentRepositoryPort,
  IOrderCommitSaleGatewayPort,
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  IDEMPOTENCY_STORE,
  OCC_RETRY_ATTEMPTS,
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
import { runWithOrderWriteRetry } from './order-write';
import { toFulfillmentView } from './fulfillment-view.factory';
import { resolveCustomerEmail } from './resolve-customer-email';

const COMMIT_SALE_MAX_ATTEMPTS = 3;

interface ICaptureOutcome {
  capturedAt: Date | null;
}

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
    @Inject(IDEMPOTENCY_STORE)
    private readonly idempotencyStore: IIdempotencyStorePort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(ShipFulfillmentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  private static readonly SCOPE = 'ship-fulfillment';

  public async execute(
    payload: IRetailFulfillmentShipPayload,
  ): Promise<IIdempotentResult<FulfillmentView>> {
    const { idempotencyKey, correlationId, orderId, fulfillmentId } = payload;

    if (!idempotencyKey) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key is required to ship a fulfillment',
      );
    }

    const fingerprint = bodyFingerprint(ShipFulfillmentUseCase.canonicalBody(payload));

    const prior = await this.idempotencyStore.find(ShipFulfillmentUseCase.SCOPE, idempotencyKey);
    if (prior) {
      if (prior.requestFingerprint === fingerprint) {
        this.logger.debug(
          { correlationId, orderId, fulfillmentId, idempotencyKey },
          'Idempotent replay — returning the stored ship response (no re-execution, no events)',
        );
        return { view: prior.responseBody as unknown as FulfillmentView, replayed: true };
      }
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REUSED,
        `Idempotency-Key ${idempotencyKey} was already used for a ship-fulfillment request with a different body`,
      );
    }

    const view = await this.ship(payload);
    await this.idempotencyStore.save({
      scope: ShipFulfillmentUseCase.SCOPE,
      key: idempotencyKey,
      requestFingerprint: fingerprint,
      responseStatus: HttpStatus.OK,
      responseBody: view as unknown as Record<string, unknown>,
    });

    const stored = await this.idempotencyStore.find(ShipFulfillmentUseCase.SCOPE, idempotencyKey);
    if (stored && (stored.responseBody as { id?: number }).id !== view.id) {
      this.logger.debug(
        { correlationId, orderId, fulfillmentId, idempotencyKey },
        'Idempotent replay — a concurrent ship stored first; returning the winning response',
      );
      return { view: stored.responseBody as unknown as FulfillmentView, replayed: true };
    }
    return { view, replayed: false };
  }

  private static canonicalBody(payload: IRetailFulfillmentShipPayload): Record<string, unknown> {
    return {
      orderId: payload.orderId,
      fulfillmentId: payload.fulfillmentId,
      trackingNumber: payload.trackingNumber,
      carrier: payload.carrier,
    };
  }

  private async ship(payload: IRetailFulfillmentShipPayload): Promise<FulfillmentView> {
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

    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffFulfill);

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

    if (typeof trackingNumber !== 'string' || trackingNumber.trim().length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_TRACKING_REQUIRED,
        'A tracking number is required to ship a fulfillment',
      );
    }

    const payment = await this.paymentRepository.findByOrderId(orderId);
    if (!payment) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
        `Order ${orderId} has no payment to capture on ship`,
      );
    }

    const capture = await this.captureIfNeeded(payment, orderId, correlationId);

    const shippedAt = new Date();

    const shippedFulfillment = await runWithOrderWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      () =>
        this.transactionPort.runInTransaction<Fulfillment>(async (scope) => {
          const fresh = await this.fulfillmentRepository.findByIdForUpdate(fulfillmentId, scope);
          if (!fresh) {
            throw new OrderDomainException(
              OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND,
              `Fulfillment ${fulfillmentId} vanished while shipping`,
            );
          }
          fresh.ship({ trackingNumber, carrier: carrier ?? null, shippedAt });
          const shipped = await this.fulfillmentRepository.save(fresh, scope);

          if (capture.capturedAt) {
            const freshPayment = await this.paymentRepository.findByOrderId(orderId, scope);
            if (!freshPayment) {
              throw new OrderDomainException(
                OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
                `Order ${orderId} has no payment to complete the capture on`,
              );
            }
            if (freshPayment.status === PaymentStatusEnum.CAPTURING) {
              freshPayment.completeCapture(capture.capturedAt);
              await this.paymentRepository.save(freshPayment, scope);
            }
          }

          const freshOrder = await this.orderRepository.findById(orderId, scope);
          if (!freshOrder) {
            throw new OrderDomainException(
              OrderErrorCodeEnum.ORDER_NOT_FOUND,
              `Order ${orderId} vanished while shipping`,
            );
          }
          const versionAtLoad = freshOrder.version;
          if (capture.capturedAt) {
            freshOrder.markPaymentCaptured();
          }

          const fulfillments = await this.fulfillmentRepository.listByOrderId(orderId, scope);
          const shippedByLine = sumLineQuantitiesByOrderLine(fulfillments, countsTowardShipped);

          const next = ShipFulfillmentUseCase.advanceLinesAndRollUp(freshOrder, shippedByLine);
          freshOrder.advanceFulfillment(next);
          await this.orderRepository.save(freshOrder, scope, versionAtLoad);

          return shipped;
        }),
      { orderId, correlationId },
    );

    await this.commitSaleWithRetry(
      this.buildCommitSalePayload(order, shippedFulfillment, actorId, correlationId),
      correlationId,
    );

    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      order.customerId,
      this.logger,
      correlationId,
    );

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

    const claimedPayment = await this.transactionPort.runInTransaction<Payment>(async (scope) => {
      const locked = await this.paymentRepository.findByOrderIdForUpdate(orderId, scope);
      if (!locked) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
          `Order ${orderId} has no payment to capture on ship`,
        );
      }
      locked.beginCapture();
      return this.paymentRepository.save(locked, scope);
    });

    const result = await this.paymentGateway.capture(
      claimedPayment.gatewayReference,
      correlationId,
    );
    if (!result.captured) {
      await this.transactionPort.runInTransaction(async (scope) => {
        const declined = await this.paymentRepository.findByOrderIdForUpdate(orderId, scope);
        if (declined) {
          declined.releaseCapture();
          await this.paymentRepository.save(declined, scope);
        }
      });
      this.logger.warn(
        { correlationId, orderId },
        'Payment gateway declined capture — claim released, blocking the ship',
      );
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_PAYMENT_NOT_CAPTURED,
        `Payment capture was declined for order ${orderId}; the ship is blocked until payment succeeds`,
      );
    }
    return { capturedAt: result.capturedAt };
  }

  private static advanceLinesAndRollUp(
    order: Order,
    shippedByLine: Map<number, number>,
  ): OrderFulfillmentStatusEnum {
    let everyLineFullyShipped = true;
    for (const line of order.lines) {
      if (line.activeQuantity === 0) {
        continue;
      }
      const shipped = shippedByLine.get(line.id!) ?? 0;
      if (shipped >= line.activeQuantity) {
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
