import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import {
  MicroserviceClientTokenEnum,
  MicroserviceEventPatternEnum,
} from '@retail-inventory-system/common';
import {
  OrderCreateDto,
  OrderCreateResponseDto,
  OrderStatusEnum,
  IOrderConfirmedEventPayload,
  OrderProductStatusEnum,
} from '@retail-inventory-system/retail';
import { Order, OrderProduct } from '../../../common/entities';

@Injectable()
export class OrderCreateService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryMicroserviceClient: ClientProxy,
  ) {}

  public async execute(dto: OrderCreateDto): Promise<OrderCreateResponseDto> {
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

    const event: IOrderConfirmedEventPayload = {
      orderId: saved.id,
      customerId: saved.customerId,
      products,
    };

    this.inventoryMicroserviceClient.emit<void, IOrderConfirmedEventPayload>(
      MicroserviceEventPatternEnum.RETAIL_ORDER_CREATED,
      event,
    );

    return {
      orderId: saved.id,
      status: OrderStatusEnum.PENDING,
    };
  }
}
