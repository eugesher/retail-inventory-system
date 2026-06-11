import { DeepPartial } from 'typeorm';

import { Order } from '../../domain';
import { OrderEntity } from './order.entity';
import { OrderLineMapper } from './order-line.mapper';

export class OrderMapper {
  // Maps the root only — lines are persisted explicitly by the repository, so this
  // partial carries no `lines` array. `id` is omitted when null so TypeORM inserts;
  // present so it updates. `version` is intentionally NOT written — TypeORM's
  // `@VersionColumn` owns the persisted value (the same omission `CartMapper` /
  // `StockLevelMapper` make), so the managed optimistic-lock token is never raced by
  // a manual value. `orderNumber` is included here, but the repository overrides it
  // with the id-derived value on a fresh insert and leaves it untouched on re-save
  // (it is immutable).
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
      // The BIGINT PK comes back as a number; coerce defensively, like the money
      // BIGINT scalars below (mysql2 returns non-PK BIGINTs as strings).
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
      // `version` is INT, returned as a number; coerce defensively for parity.
      version: Number(entity.version),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
