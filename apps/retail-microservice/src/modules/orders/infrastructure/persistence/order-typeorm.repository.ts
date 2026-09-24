import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { BaseTypeormRepository, entityManagerOf } from '@retail-inventory-system/database';

import { Order } from '../../domain';
import {
  IOrderPage,
  IOrderPageRequest,
  IOrderRepositoryPort,
  ITransactionScope,
} from '../../application/ports';
import { OrderWriteConflictError } from '../../application/use-cases/order-write-conflict.error';
import { OrderEntity } from './order.entity';
import { OrderLineEntity } from './order-line.entity';
import { OrderLineMapper } from './order-line.mapper';
import { OrderMapper } from './order.mapper';

@Injectable()
export class OrderTypeormRepository
  extends BaseTypeormRepository<OrderEntity, Order>
  implements IOrderRepositoryPort
{
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderLineEntity)
    private readonly orderLineRepository: Repository<OrderLineEntity>,
    @InjectPinoLogger(OrderTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(orderRepository);
  }

  protected toDomain(entity: OrderEntity): Order {
    return OrderMapper.toDomain(entity);
  }

  protected toEntity(domain: Order): DeepPartial<OrderEntity> {
    return OrderMapper.toEntity(domain);
  }

  public async findById(id: number, scope?: ITransactionScope): Promise<Order | null> {
    const entity = await this.orderRepo(scope).findOne({
      where: { id },
      relations: { lines: true },
      order: { lines: { id: 'ASC' } },
    });
    return entity ? OrderMapper.toDomain(entity) : null;
  }

  public async findBySourceCartId(cartId: string): Promise<Order | null> {
    const entity = await this.orderRepository.findOne({
      where: { sourceCartId: cartId },
      relations: { lines: true },
      order: { id: 'DESC', lines: { id: 'ASC' } },
    });
    return entity ? OrderMapper.toDomain(entity) : null;
  }

  public async listByCustomer(customerId: string, page: IOrderPageRequest): Promise<IOrderPage> {
    const [entities, total] = await this.orderRepository.findAndCount({
      where: { customerId },
      relations: { lines: true },
      order: { placedAt: 'DESC', id: 'DESC', lines: { id: 'ASC' } },
      skip: (page.page - 1) * page.size,
      take: page.size,
    });
    return {
      items: entities.map((entity) => OrderMapper.toDomain(entity)),
      total,
      page: page.page,
      size: page.size,
    };
  }

  public async save(
    order: Order,
    scope?: ITransactionScope,
    expectedVersion?: number,
  ): Promise<Order> {
    let orderId: number;
    try {
      if (scope) {
        orderId = await this.persistGraph(entityManagerOf(scope), order, expectedVersion);
      } else {
        orderId = await this.orderRepository.manager.transaction((manager) =>
          this.persistGraph(manager, order, expectedVersion),
        );
      }
    } catch (error) {
      if (error instanceof OrderWriteConflictError) {
        const current = await this.orderRepository.findOne({ where: { id: error.orderId } });
        throw new OrderWriteConflictError(
          error.orderId,
          current ? Number(current.version) : expectedVersion!,
        );
      }
      throw error;
    }

    const reloaded = await this.findById(orderId, scope);
    if (!reloaded) {
      throw new Error(`OrderTypeormRepository.save: order ${orderId} vanished after commit`);
    }
    return reloaded;
  }

  public async attachAddresses(
    orderId: number,
    billingAddressId: string,
    shippingAddressId: string,
    scope?: ITransactionScope,
  ): Promise<void> {
    await this.orderRepo(scope).update({ id: orderId }, { billingAddressId, shippingAddressId });
  }

  private async persistGraph(
    manager: EntityManager,
    order: Order,
    expectedVersion: number | undefined,
  ): Promise<number> {
    const orderRepo = manager.getRepository(OrderEntity);
    const lineRepo = manager.getRepository(OrderLineEntity);

    if (order.id === null) {
      const rootPartial = OrderMapper.toEntity(order);
      rootPartial.orderNumber = `TMP-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const inserted = await orderRepo.save(rootPartial);
      const newId = Number(inserted.id);

      const year = (order.placedAt ?? new Date()).getUTCFullYear();
      const orderNumber = OrderTypeormRepository.formatOrderNumber(year, newId);
      await orderRepo.update({ id: newId }, { orderNumber });

      await this.persistLines(lineRepo, order, newId);
      this.logger.debug({ orderId: newId, orderNumber }, 'Order placed');
      return newId;
    }

    const existingId = order.id;
    await this.persistRoot(orderRepo, order, existingId, expectedVersion);

    await this.persistLines(lineRepo, order, existingId);
    this.logger.debug({ orderId: existingId }, 'Order updated');
    return existingId;
  }

  private async persistRoot(
    orderRepo: Repository<OrderEntity>,
    order: Order,
    existingId: number,
    expectedVersion: number | undefined,
  ): Promise<void> {
    if (expectedVersion === undefined) {
      const rootPartial = OrderMapper.toEntity(order);
      delete rootPartial.orderNumber;
      await orderRepo.save({ ...rootPartial, id: existingId });
      return;
    }

    const result = await orderRepo.update(
      { id: existingId, version: expectedVersion },
      {
        customerId: order.customerId,
        currency: order.currency,
        status: order.status,
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        subtotalMinor: order.subtotalMinor,
        taxTotalMinor: order.taxTotalMinor,
        discountTotalMinor: order.discountTotalMinor,
        shippingTotalMinor: order.shippingTotalMinor,
        grandTotalMinor: order.grandTotalMinor,
        billingAddressId: order.billingAddressId,
        shippingAddressId: order.shippingAddressId,
        sourceCartId: order.sourceCartId,
        placedAt: order.placedAt,
        version: (): string => 'version + 1',
      },
    );

    if (!result.affected) {
      throw new OrderWriteConflictError(existingId, expectedVersion);
    }
  }

  private async persistLines(
    lineRepo: Repository<OrderLineEntity>,
    order: Order,
    orderId: number,
  ): Promise<void> {
    const lineEntities = order.lines.map((line) => OrderLineMapper.toEntity(line, orderId));
    if (lineEntities.length > 0) {
      await lineRepo.save(lineEntities);
    }
  }

  private orderRepo(scope?: ITransactionScope): Repository<OrderEntity> {
    if (!scope) {
      return this.orderRepository;
    }
    return entityManagerOf(scope).getRepository(OrderEntity);
  }

  private static formatOrderNumber(year: number, id: number): string {
    return `ORD-${year}-${String(id).padStart(8, '0')}`;
  }
}
