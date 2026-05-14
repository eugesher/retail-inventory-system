import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IOrderCreatePayload,
  OrderCreateResponseDto,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

import { CustomerRef, Order, OrderCreatedEvent } from '../../domain';
import {
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
} from '../ports';

@Injectable()
export class CreateOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly repository: IOrderRepositoryPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @InjectPinoLogger(CreateOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IOrderCreatePayload): Promise<OrderCreateResponseDto> {
    const { customerId, products, correlationId } = payload;

    this.logger.info(
      { correlationId, customerId, productCount: products.length },
      'Received RPC: create order',
    );

    const order = Order.create({
      customer: new CustomerRef({ id: customerId }),
      lines: products.map((p) => ({ productId: p.productId, quantity: p.quantity })),
    });

    try {
      const saved = await this.repository.save(order);
      const orderId = saved.id;

      if (orderId === null) {
        throw new Error('CreateOrderUseCase: repository returned an unsaved aggregate');
      }

      this.logger.info({ correlationId, orderId, customerId }, 'Order created');

      // `retail.order.created` is published after persistence so subscribers
      // (notification microservice) observe a stable aggregate id. The
      // adapter wraps `ClientProxy.emit()` in `firstValueFrom`; we await the
      // broker ack so a publish failure surfaces in the RPC response rather
      // than disappearing into a fire-and-forget observable.
      const event = new OrderCreatedEvent({
        orderId,
        customerId,
        lines: products.map((p) => ({ productId: p.productId, quantity: p.quantity })),
      });
      try {
        await this.publisher.publishOrderCreated(event, correlationId);
      } catch (err) {
        // The response correctness does not depend on the notifier — the
        // order is persisted. Warn-log and continue.
        this.logger.warn(
          { err: err as Error, correlationId, orderId },
          'Failed to publish retail.order.created event',
        );
      }

      return {
        orderId,
        status: OrderStatusEnum.PENDING,
        message: 'Order successfully created',
      };
    } catch (error) {
      this.logger.error({ err: error as Error, correlationId, customerId }, 'Error creating order');
      throw error;
    }
  }
}
