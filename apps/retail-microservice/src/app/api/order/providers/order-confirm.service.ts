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

  public async execute(id: number): Promise<OrderConfirmResponseDto> {
    const order = (await this.orderRepository.findOne({
      where: { id },
      relations: ['products'],
    }))!;

    const payload: IOrderProductConfirmItem[] = order.products.map(
      ({ id: productRowId, productId, statusId }) => ({
        id: productRowId,
        productId,
        statusId,
      }),
    );

    // Step 4.1: Call inventory BEFORE opening the transaction
    const confirmedIds = await firstValueFrom(
      this.inventoryMicroserviceClient.send<number[], IOrderProductConfirmItem[]>(
        MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM,
        payload,
      ),
    );

    // Step 4.2–4.4: Database transaction
    await this.orderRepository.manager.transaction(async (manager) => {
      if (confirmedIds.length > 0) {
        await manager.update(
          OrderProduct,
          { id: In(confirmedIds) },
          { statusId: OrderProductStatusEnum.CONFIRMED },
        );
      }

      const allConfirmed = order.products.every(
        (p) => confirmedIds.includes(p.id) || p.statusId === OrderProductStatusEnum.CONFIRMED,
      );

      if (allConfirmed) {
        await manager.update(Order, { id }, { statusId: OrderStatusEnum.CONFIRMED });
      }
    });

    // Step 4.5: Re-fetch with full relations for response
    const updatedOrder = (await this.orderRepository.findOne({
      where: { id },
      relations: ['status', 'products', 'products.status'],
    }))!;

    return {
      id: updatedOrder.id,
      status: updatedOrder.status,
      products: updatedOrder.products.map(({ id: pid, productId, status }) => ({
        id: pid,
        productId,
        status,
      })),
    };
  }
}
