import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentStatusEnum,
  IAllocationCancelPayload,
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IRetailOrderCancelPayload,
  OrderView,
  PaymentStatusEnum,
} from '@retail-inventory-system/contracts';

import { Fulfillment, Order, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderInventoryGatewayPort,
  IOrderRepositoryPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  OCC_RETRY_ATTEMPTS,
  ORDER_CUSTOMER_CONTACT_READER,
  ORDER_EVENTS_PUBLISHER,
  ORDER_INVENTORY_GATEWAY,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { releaseAllocationWithRetry } from './cancel-allocation-retry';
import { loadAuthorizedOrder } from './order-access';
import { runWithOrderWriteRetry } from './order-write';
import { toOrderView } from './order-view.factory';
import { resolveCustomerEmail } from './resolve-customer-email';

@Injectable()
export class CancelOrderUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(ORDER_INVENTORY_GATEWAY)
    private readonly inventoryGateway: IOrderInventoryGatewayPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @Inject(ORDER_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IOrderCustomerContactReaderPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(CancelOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailOrderCancelPayload): Promise<OrderView> {
    const { orderId, reason, actorId, isStaffCancel, correlationId } = payload;

    this.logger.info(
      { correlationId, orderId, actorId, isStaffCancel, reason },
      'Cancelling order',
    );

    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffCancel);

    const fulfillments = await this.fulfillmentRepository.listByOrderId(orderId);
    if (CancelOrderUseCase.hasShippedFulfillment(fulfillments)) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE,
        `Order ${orderId} has a shipped or delivered fulfillment and cannot be cancelled`,
      );
    }

    const paymentFlaggedForRefund = await runWithOrderWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      () =>
        this.transactionPort.runInTransaction<boolean>(async (scope) => {
          const freshOrder = await this.orderRepository.findById(orderId, scope);
          if (!freshOrder) {
            throw new OrderDomainException(
              OrderErrorCodeEnum.ORDER_NOT_FOUND,
              `Order ${orderId} vanished while cancelling`,
            );
          }
          const versionAtLoad = freshOrder.version;

          const locked: Fulfillment[] = [];
          for (const planned of await this.fulfillmentRepository.listByOrderId(orderId, scope)) {
            const lockedFulfillment = await this.fulfillmentRepository.findByIdForUpdate(
              planned.id!,
              scope,
            );
            if (lockedFulfillment) {
              locked.push(lockedFulfillment);
            }
          }
          if (CancelOrderUseCase.hasShippedFulfillment(locked)) {
            throw new OrderDomainException(
              OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE,
              `Order ${orderId} has a shipped or delivered fulfillment and cannot be cancelled`,
            );
          }

          freshOrder.cancel();

          for (const fulfillment of locked) {
            if (fulfillment.status === FulfillmentStatusEnum.PENDING) {
              fulfillment.cancel();
              await this.fulfillmentRepository.save(fulfillment, scope);
            }
          }

          const payment = await this.paymentRepository.findByOrderIdForUpdate(orderId, scope);
          let flagged = false;
          if (payment) {
            if (payment.status === PaymentStatusEnum.CAPTURING) {
              throw new OrderDomainException(
                OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE,
                `Order ${orderId} has a payment capture in flight and cannot be cancelled; retry once it settles`,
              );
            }
            if (payment.status === PaymentStatusEnum.CAPTURED) {
              payment.flagForRefund();
              flagged = true;
              await this.paymentRepository.save(payment, scope);
            } else if (payment.status === PaymentStatusEnum.AUTHORIZED) {
              payment.void();
              await this.paymentRepository.save(payment, scope);
            }
          }

          await this.orderRepository.save(freshOrder, scope, versionAtLoad);
          return flagged;
        }),
      { orderId, correlationId },
    );

    const allocationPayload = CancelOrderUseCase.buildCancelAllocationPayload(
      order,
      actorId,
      correlationId,
    );
    if (allocationPayload.lines.length > 0) {
      await releaseAllocationWithRetry(
        this.inventoryGateway,
        allocationPayload,
        this.logger,
        correlationId,
      );
    }

    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      order.customerId,
      this.logger,
      correlationId,
    );

    await this.emitCancelled(
      orderId,
      customerEmail,
      reason ?? null,
      paymentFlaggedForRefund,
      correlationId,
    );

    const [finalOrder, finalPayment] = await Promise.all([
      this.orderRepository.findById(orderId),
      this.paymentRepository.findByOrderId(orderId),
    ]);
    if (!finalOrder) {
      throw new Error(`CancelOrderUseCase: order ${orderId} vanished after cancel`);
    }

    this.logger.info({ correlationId, orderId, paymentFlaggedForRefund }, 'Order cancelled');
    return toOrderView(finalOrder, finalPayment);
  }

  private static hasShippedFulfillment(fulfillments: Fulfillment[]): boolean {
    return fulfillments.some(
      (f) =>
        f.status === FulfillmentStatusEnum.SHIPPED || f.status === FulfillmentStatusEnum.DELIVERED,
    );
  }

  private static buildCancelAllocationPayload(
    order: Order,
    actorId: string,
    correlationId: string,
  ): Omit<IAllocationCancelPayload, 'operationKey'> {
    return {
      orderId: order.id!,
      lines: order.lines
        .filter((line) => line.activeQuantity > 0)
        .map((line) => ({
          variantId: line.variantId,
          stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION,
          quantity: line.activeQuantity,
        })),
      reason: 'order-cancelled',
      actorId,
      correlationId,
    };
  }

  private async emitCancelled(
    orderId: number,
    customerEmail: string | null,
    reason: string | null,
    paymentFlaggedForRefund: boolean,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishOrderCancelled({
        orderId,
        customerEmail,
        customerLocale: null,
        cancelledAt: new Date().toISOString(),
        reason,
        paymentFlaggedForRefund,
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, orderId },
        'Failed to publish retail.order.cancelled (cancel already committed)',
      );
    }
  }
}
