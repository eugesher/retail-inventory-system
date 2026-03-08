import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MicroserviceClientTokenEnum } from '@retail-inventory-system/common';
import {
  OrderProductStatusEnum,
  OrderResponseDto,
  OrderStatusEnum,
} from '@retail-inventory-system/retail';
import { Order } from '../../../common/entities';

@Injectable()
export class OrderConfirmService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryMicroserviceClient: ClientProxy,
  ) {}

  public async execute(id: number): Promise<OrderResponseDto> {
    const order = (await this.orderRepository.findOne({
      where: { id },
      relations: ['products'],
    }))!;

    order.statusId = OrderStatusEnum.CONFIRMED;

    for (const orderProduct of order.products) {
      orderProduct.statusId = OrderProductStatusEnum.CONFIRMED;
    }

    await this.orderRepository.save(order);

    return {
      orderId: id,
      status: OrderStatusEnum.CONFIRMED,
      message: 'Order successfully confirmed',
    };
  }
}
