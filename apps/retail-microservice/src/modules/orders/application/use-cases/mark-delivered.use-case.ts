import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentStatusEnum,
  FulfillmentView,
  IRetailFulfillmentDeliverPayload,
} from '@retail-inventory-system/contracts';

import { Fulfillment, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  ITransactionPort,
  OCC_RETRY_ATTEMPTS,
  ORDER_CUSTOMER_CONTACT_READER,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { loadAuthorizedOrder } from './order-access';
import { runWithOrderWriteRetry } from './order-write';
import { toFulfillmentView } from './fulfillment-view.factory';
import { resolveCustomerEmail } from './resolve-customer-email';

@Injectable()
export class MarkDeliveredUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @Inject(ORDER_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IOrderCustomerContactReaderPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(MarkDeliveredUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailFulfillmentDeliverPayload): Promise<FulfillmentView> {
    const { orderId, fulfillmentId, actorId, isStaffFulfill, correlationId } = payload;

    this.logger.info(
      { correlationId, orderId, fulfillmentId, actorId, isStaffFulfill },
      'Marking fulfillment delivered',
    );

    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffFulfill);

    const fulfillment = await this.fulfillmentRepository.findById(fulfillmentId);
    if (fulfillment?.orderId !== orderId) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND,
        `Fulfillment ${fulfillmentId} not found on order ${orderId}`,
      );
    }
    if (fulfillment.status !== FulfillmentStatusEnum.SHIPPED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
        `Fulfillment ${fulfillmentId} is ${fulfillment.status} and cannot be delivered`,
      );
    }

    const deliveredAt = new Date();

    const delivered = await runWithOrderWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      () =>
        this.transactionPort.runInTransaction<Fulfillment>(async (scope) => {
          const fresh = await this.fulfillmentRepository.findByIdForUpdate(fulfillmentId, scope);
          if (!fresh) {
            throw new OrderDomainException(
              OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND,
              `Fulfillment ${fulfillmentId} vanished while delivering`,
            );
          }
          fresh.markDelivered(deliveredAt);
          const saved = await this.fulfillmentRepository.save(fresh, scope);

          const all = await this.fulfillmentRepository.listByOrderId(orderId, scope);
          if (MarkDeliveredUseCase.everyFulfillmentDelivered(all)) {
            const freshOrder = await this.orderRepository.findById(orderId, scope);
            if (!freshOrder) {
              throw new OrderDomainException(
                OrderErrorCodeEnum.ORDER_NOT_FOUND,
                `Order ${orderId} vanished while delivering`,
              );
            }
            const versionAtLoad = freshOrder.version;
            freshOrder.markDelivered();
            await this.orderRepository.save(freshOrder, scope, versionAtLoad);
          }

          return saved;
        }),
      { orderId, correlationId },
    );

    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      order.customerId,
      this.logger,
      correlationId,
    );

    await this.emitDelivered(delivered, customerEmail, correlationId);

    this.logger.info({ correlationId, orderId, fulfillmentId }, 'Fulfillment delivered');
    return toFulfillmentView(delivered);
  }

  private static everyFulfillmentDelivered(fulfillments: Fulfillment[]): boolean {
    const live = fulfillments.filter((f) => f.status !== FulfillmentStatusEnum.CANCELLED);
    return live.length > 0 && live.every((f) => f.status === FulfillmentStatusEnum.DELIVERED);
  }

  private async emitDelivered(
    fulfillment: Fulfillment,
    customerEmail: string | null,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishFulfillmentDelivered({
        orderId: fulfillment.orderId,
        fulfillmentId: fulfillment.id!,
        customerEmail,
        customerLocale: null,
        deliveredAt: (fulfillment.deliveredAt ?? new Date()).toISOString(),
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, fulfillmentId: fulfillment.id },
        'Failed to publish retail.fulfillment.delivered (delivery already committed)',
      );
    }
  }
}
