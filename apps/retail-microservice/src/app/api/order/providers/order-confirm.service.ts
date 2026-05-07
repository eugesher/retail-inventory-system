import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom } from 'rxjs';
import { In, Repository } from 'typeorm';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { IProductStockOrderConfirmPayload } from '@retail-inventory-system/inventory';
import {
  IOrderConfirm,
  OrderConfirmResponseDto,
  OrderProductStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/retail';
import { Order, OrderProduct } from '../../../common/entities';
import { OrderConfirmDomain } from '../domain';

@Injectable()
export class OrderConfirmService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryMicroserviceClient: ClientProxy,
    @InjectPinoLogger(OrderConfirmService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(order: IOrderConfirm): Promise<OrderConfirmResponseDto> {
    const { id, products, correlationId } = order;

    try {
      this.logger.info(
        { correlationId, orderId: id, productCount: products.length },
        'Received RPC: confirm order',
      );
      this.logger.info(
        { correlationId, pattern: MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM },
        'Sending RPC to inventory service',
      );

      const confirmedOrderProductIds = await firstValueFrom(
        this.inventoryMicroserviceClient.send<number[], IProductStockOrderConfirmPayload>(
          MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM,
          { products, correlationId },
        ),
      );

      this.logger.info(
        { correlationId, orderId: id, confirmedCount: confirmedOrderProductIds.length },
        'Inventory stock confirmation received',
      );

      const result = new OrderConfirmDomain(order, confirmedOrderProductIds);

      if (result.skipUpdate) {
        this.logger.debug({ correlationId, orderId: id }, 'No state update required');
        return await this.getOrder(id);
      }

      await this.orderRepository.manager.transaction(async (entityManager) => {
        if (result.someProductsConfirmed) {
          await entityManager.update(
            OrderProduct,
            { id: In(confirmedOrderProductIds) },
            { statusId: OrderProductStatusEnum.CONFIRMED },
          );
          this.logger.debug(
            { correlationId, orderId: id, confirmedIds: confirmedOrderProductIds },
            'Order products updated to confirmed',
          );
        }

        if (result.allProductsConfirmed) {
          await entityManager.update(Order, { id }, { statusId: OrderStatusEnum.CONFIRMED });
          this.logger.info({ correlationId, orderId: id }, 'Order fully confirmed');
        } else {
          this.logger.warn(
            {
              correlationId,
              orderId: id,
              confirmedCount: confirmedOrderProductIds.length,
              totalCount: products.length,
            },
            'Order partially confirmed',
          );
        }
      });

      return await this.getOrder(id);
    } catch (error) {
      this.logger.error(error, 'Error confirming order');
      throw error;
    }
  }

  private async getOrder(id: number): Promise<OrderConfirmResponseDto> {
    const order = await this.orderRepository
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
      .where('Order.id = :id', { id })
      .getOne();

    if (!order) {
      throw new Error(`Order #${id} not found after confirmation`);
    }

    return order;
  }
}
