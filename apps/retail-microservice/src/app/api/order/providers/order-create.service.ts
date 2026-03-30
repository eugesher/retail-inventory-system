import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, Repository } from 'typeorm';

import {
  IOrderCreatePayload,
  OrderCreateResponseDto,
  OrderProductStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/retail';
import { Order, OrderProduct } from '../../../common/entities';

@Injectable()
export class OrderCreateService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectPinoLogger(OrderCreateService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(dto: IOrderCreatePayload): Promise<OrderCreateResponseDto> {
    const { customerId, products, correlationId } = dto;

    this.logger.info(
      { correlationId, customerId, productCount: products.length },
      'Received RPC: create order',
    );

    const orderProducts: DeepPartial<OrderProduct>[] = [];

    for (const product of products) {
      const { productId, quantity } = product;

      for (let i = 0; i < quantity; i++) {
        orderProducts.push({
          productId,
          statusId: OrderProductStatusEnum.PENDING,
        });
      }
    }

    const order = this.orderRepository.create({
      customerId,
      products: orderProducts,
      statusId: OrderStatusEnum.PENDING,
    });

    try {
      const saved = await this.orderRepository.save(order);

      this.logger.info({ correlationId, orderId: saved.id, customerId }, 'Order created');

      return {
        orderId: saved.id,
        status: OrderStatusEnum.PENDING,
        message: 'Order successfully created',
      };
    } catch (error) {
      this.logger.error(error, 'Error creating order');
      throw error;
    }
  }
}
