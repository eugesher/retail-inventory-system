import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IOrderCreatePayload,
  OrderCreateResponseDto,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

import { Order, OrderCreatedEvent } from '../../domain';
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
    const { products, correlationId } = payload;

    this.logger.info(
      { correlationId, productCount: products.length },
      'Received RPC: create order',
    );

    const order = Order.create({
      lines: products.map((p) => ({ productId: p.productId, quantity: p.quantity })),
    });

    try {
      const saved = await this.repository.save(order);
      const orderId = saved.id;

      if (orderId === null) {
        throw new Error('CreateOrderUseCase: repository returned an unsaved aggregate');
      }

      this.logger.info({ correlationId, orderId }, 'Order created');

      const event = new OrderCreatedEvent({
        orderId,
        lines: products.map((p) => ({ productId: p.productId, quantity: p.quantity })),
      });
      try {
        await this.publisher.publishOrderCreated(event, correlationId);
      } catch (err) {
        // Publish failures never raise — the order is already persisted.
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
      this.logger.error({ err: error as Error, correlationId }, 'Error creating order');
      throw error;
    }
  }
}
