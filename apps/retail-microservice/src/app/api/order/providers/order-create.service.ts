import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import {
  OrderCreateDto,
  OrderResponseDto,
  OrderStatusEnum,
  OrderProductStatusEnum,
} from '@retail-inventory-system/retail';
import { Order, OrderProduct } from '../../../common/entities';

@Injectable()
export class OrderCreateService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  public async execute(dto: OrderCreateDto): Promise<OrderResponseDto> {
    const { customerId, products } = dto;
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

    const saved = await this.orderRepository.save(order);

    return {
      orderId: saved.id,
      status: OrderStatusEnum.PENDING,
      message: 'Order successfully created',
    };
  }
}
