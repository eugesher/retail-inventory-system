import { DeepPartial } from 'typeorm';

import { Order } from '../../domain';
import { OrderEntity } from './order.entity';
import { OrderLineMapper } from './order-line.mapper';

export class OrderMapper {
  public static toEntity(domain: Order): DeepPartial<OrderEntity> {
    const entity: DeepPartial<OrderEntity> = {
      orderNumber: domain.orderNumber,
      customerId: domain.customerId,
      currency: domain.currency,
      status: domain.status,
      paymentStatus: domain.paymentStatus,
      fulfillmentStatus: domain.fulfillmentStatus,
      subtotalMinor: domain.subtotalMinor,
      taxTotalMinor: domain.taxTotalMinor,
      discountTotalMinor: domain.discountTotalMinor,
      shippingTotalMinor: domain.shippingTotalMinor,
      grandTotalMinor: domain.grandTotalMinor,
      billingAddressId: domain.billingAddressId,
      shippingAddressId: domain.shippingAddressId,
      sourceCartId: domain.sourceCartId,
      placedAt: domain.placedAt,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: OrderEntity): Order {
    return Order.reconstitute({
      id: Number(entity.id),
      orderNumber: entity.orderNumber,
      customerId: entity.customerId,
      currency: entity.currency,
      status: entity.status,
      paymentStatus: entity.paymentStatus,
      fulfillmentStatus: entity.fulfillmentStatus,
      lines: (entity.lines ?? []).map((line) => OrderLineMapper.toDomain(line)),
      subtotalMinor: Number(entity.subtotalMinor),
      taxTotalMinor: Number(entity.taxTotalMinor),
      discountTotalMinor: Number(entity.discountTotalMinor),
      shippingTotalMinor: Number(entity.shippingTotalMinor),
      grandTotalMinor: Number(entity.grandTotalMinor),
      billingAddressId: entity.billingAddressId ?? null,
      shippingAddressId: entity.shippingAddressId ?? null,
      sourceCartId: entity.sourceCartId ?? null,
      placedAt: entity.placedAt ?? null,
      version: Number(entity.version),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
