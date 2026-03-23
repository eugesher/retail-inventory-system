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
  IOrderProductConfirmItem,
  OrderConfirmResponseDto,
  OrderProductStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/retail';
import { Order, OrderProduct } from '../../../common/entities';

@Injectable()
export class OrderConfirmService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryMicroserviceClient: ClientProxy,
  ) {}

  public async execute(id: Order['id']): Promise<OrderConfirmResponseDto> {
    const order = (await this.orderRepository.findOne({
      where: { id },
      relations: ['products'],
    }))!;

    const payload: IOrderProductConfirmItem[] = order.products.map(
      ({ id: productRowId, productId, statusId }) => ({ id: productRowId, productId, statusId }),
    );

    const confirmedIds = await firstValueFrom(
      this.inventoryMicroserviceClient.send<number[], IOrderProductConfirmItem[]>(
        MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM,
        payload,
      ),
    );

    await this.orderRepository.manager.transaction(async (entityManager) => {
      if (confirmedIds.length > 0) {
        await entityManager.update(
          OrderProduct,
          { id: In(confirmedIds) },
          { statusId: OrderProductStatusEnum.CONFIRMED },
        );
      }

      const confirmedSet = new Set(confirmedIds);
      const allConfirmed = order.products.every(
        (p) => confirmedSet.has(p.id) || p.statusId === OrderProductStatusEnum.CONFIRMED,
      );

      if (allConfirmed) {
        await entityManager.update(Order, { id }, { statusId: OrderStatusEnum.CONFIRMED });
      }
    });

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
