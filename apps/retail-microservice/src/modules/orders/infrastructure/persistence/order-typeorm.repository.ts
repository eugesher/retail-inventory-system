import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, In, Repository } from 'typeorm';

import {
  IOrderConfirm,
  OrderConfirmResponseDto,
  OrderProductStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

import { Order as OrderDomain } from '../../domain';
import { IOrderRepositoryPort } from '../../application/ports';
import { Order as OrderEntity } from './order.entity';
import { OrderProduct as OrderProductEntity } from './order-product.entity';
import { OrderMapper } from './order.mapper';

@Injectable()
export class OrderTypeormRepository implements IOrderRepositoryPort {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectPinoLogger(OrderTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {}

  public async findById(id: number): Promise<OrderDomain | null> {
    const entity = await this.orderRepository.findOne({
      where: { id },
      relations: { products: true },
    });
    return entity ? OrderMapper.toDomain(entity) : null;
  }

  public async findHeaderById(id: number): Promise<{ statusId: OrderStatusEnum } | null> {
    const row = await this.orderRepository
      .createQueryBuilder('Order')
      .select(['Order.id', 'Order.statusId'])
      .where('Order.id = :id', { id })
      .getOne();
    return row ? { statusId: row.statusId } : null;
  }

  public async findConfirmableOrder(
    id: number,
  ): Promise<Omit<IOrderConfirm, 'correlationId'> | null> {
    const order = await this.orderRepository
      .createQueryBuilder('Order')
      .leftJoin('Order.products', 'OrderProduct')
      .select(['Order.id', 'OrderProduct.id', 'OrderProduct.productId', 'OrderProduct.statusId'])
      .where('Order.id = :id', { id })
      .getOne();
    if (!order) return null;
    return {
      id: order.id,
      products: (order.products ?? []).map((line) => ({
        id: line.id,
        productId: line.productId,
        statusId: line.statusId,
      })),
    };
  }

  public async findOrderResponse(id: number): Promise<OrderConfirmResponseDto | null> {
    return this.orderRepository
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
      .getOne()
      .then((order) => order as OrderConfirmResponseDto | null);
  }

  public async save(order: OrderDomain): Promise<OrderDomain> {
    const partial: DeepPartial<OrderEntity> = {
      statusId: order.statusId,
      products: order.products.map((line) => ({
        productId: line.productId,
        statusId: line.statusId,
      })),
    };

    const saved = await this.orderRepository.save(partial);
    return OrderMapper.toDomain(saved as OrderEntity);
  }

  public async confirmLines(payload: {
    orderId: number;
    newlyConfirmedProductIds: number[];
    shouldFlipHeaderToConfirmed: boolean;
    correlationId?: string;
  }): Promise<void> {
    const { orderId, newlyConfirmedProductIds, shouldFlipHeaderToConfirmed, correlationId } =
      payload;

    await this.orderRepository.manager.transaction(async (em) => {
      if (newlyConfirmedProductIds.length > 0) {
        await em.update(
          OrderProductEntity,
          { id: In(newlyConfirmedProductIds) },
          { statusId: OrderProductStatusEnum.CONFIRMED },
        );
        this.logger.debug(
          { correlationId, orderId, confirmedIds: newlyConfirmedProductIds },
          'Order products updated to confirmed',
        );
      }

      if (shouldFlipHeaderToConfirmed) {
        await em.update(OrderEntity, { id: orderId }, { statusId: OrderStatusEnum.CONFIRMED });
      }
    });
  }
}
