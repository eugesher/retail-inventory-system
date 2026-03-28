import { HttpStatus, Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryFailedError, Repository } from 'typeorm';

import {
  IOrderCreatePayload,
  OrderProductStatusEnum,
  OrderResponseDto,
  OrderStatusEnum,
} from '@retail-inventory-system/retail';
import { Order, OrderProduct } from '../../../common/entities';

@Injectable()
export class OrderCreateService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  public async execute(dto: IOrderCreatePayload): Promise<OrderResponseDto> {
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

    try {
      const saved = await this.orderRepository.save(order);

      return {
        orderId: saved.id,
        status: OrderStatusEnum.PENDING,
        message: 'Order successfully created',
      };
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === 'ER_NO_REFERENCED_ROW_2'
      ) {
        throw new RpcException({
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'One or more product IDs are invalid',
        });
      }

      throw error;
    }
  }
}
