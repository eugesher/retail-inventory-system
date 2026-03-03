import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  MicroserviceClientTokenEnum,
  MicroserviceEventPatternEnum,
} from '@retail-inventory-system/microservices';
import {
  OrderCreateDto,
  OrderCreateResponseDto,
  OrderStatusEnum,
  IOrderCreatedEventPayload,
} from '@retail-inventory-system/retail';
import { Order } from '../../../common/entities';

@Injectable()
export class OrderCreateService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryMicroserviceClient: ClientProxy,
  ) {}

  public async execute(dto: OrderCreateDto): Promise<OrderCreateResponseDto> {
    const total = dto.items.reduce((sum, item) => sum + item.quantity * 10, 0);

    const order = this.orderRepository.create({
      customerId: dto.customerId,
      items: dto.items,
      shippingAddress: dto.shippingAddress,
      total,
      status: OrderStatusEnum.PENDING,
    });

    const saved = await this.orderRepository.save(order);

    const event: IOrderCreatedEventPayload = {
      orderId: saved.id,
      customerId: saved.customerId,
      items: saved.items,
      total: saved.total,
      createdAt: saved.createdAt,
    };

    this.inventoryMicroserviceClient.emit(MicroserviceEventPatternEnum.RETAIL_ORDER_CREATED, event);

    return {
      orderId: saved.id,
      status: OrderStatusEnum.PENDING,
    };
  }
}
