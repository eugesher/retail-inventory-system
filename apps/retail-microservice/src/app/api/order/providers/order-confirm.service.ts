import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { In, Repository } from 'typeorm';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import {
  IOrderConfirm,
  IOrderProductConfirmItem,
  OrderConfirmResponseDto,
  OrderProductStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/retail';
import { Order, OrderProduct } from '../../../common/entities';
import { OrderConfirmModel } from '../models';

@Injectable()
export class OrderConfirmService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryMicroserviceClient: ClientProxy,
  ) {}

  public async execute(order: IOrderConfirm): Promise<OrderConfirmResponseDto> {
    const { id, products } = order;

    const confirmedOrderProductIds = await firstValueFrom(
      this.inventoryMicroserviceClient.send<number[], IOrderProductConfirmItem[]>(
        MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM,
        products,
      ),
    );

    const model = new OrderConfirmModel(order, confirmedOrderProductIds);

    if (model.skipUpdate) {
      return await this.getOrder(id);
    }

    await this.orderRepository.manager.transaction(async (entityManager) => {
      if (model.someProductsConfirmed) {
        await entityManager.update(
          OrderProduct,
          { id: In(confirmedOrderProductIds) },
          { statusId: OrderProductStatusEnum.CONFIRMED },
        );
      }

      if (model.allProductsConfirmed) {
        await entityManager.update(Order, { id }, { statusId: OrderStatusEnum.CONFIRMED });
      }
    });

    return await this.getOrder(id);
  }

  private async getOrder(id: number): Promise<OrderConfirmResponseDto> {
    const builder = this.orderRepository
      .createQueryBuilder('Order')
      .leftJoin('Order.status', 'OrderStatus')
      .leftJoin('Order.products', 'OrderProduct')
      .leftJoin('OrderProduct.status', 'OrderProductStatus')
      .select([
        'Order.id',
        'OrderStatus.id',
        'OrderStatus.name',
        'OrderStatus.color',
        'OrderProduct.id',
        'OrderProduct.productId',
        'OrderProductStatus.id',
        'OrderProductStatus.name',
        'OrderProductStatus.color',
      ])
      .where('Order.id = :id', { id });

    return (await builder.getOne())!;
  }
}
