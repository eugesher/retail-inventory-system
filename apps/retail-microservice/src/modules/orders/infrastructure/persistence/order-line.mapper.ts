import { DeepPartial } from 'typeorm';

import { OrderLine } from '../../domain';
import { OrderEntity } from './order.entity';
import { OrderLineEntity } from './order-line.entity';

export class OrderLineMapper {
  public static toEntity(domain: OrderLine, orderId: number): DeepPartial<OrderLineEntity> {
    const entity: DeepPartial<OrderLineEntity> = {
      order: { id: orderId } as OrderEntity,
      variantId: domain.variantId,
      sku: domain.sku,
      nameSnapshot: domain.nameSnapshot,
      quantity: domain.quantity,
      cancelledQuantity: domain.cancelledQuantity,
      unitPriceMinor: domain.unitPriceMinor,
      taxAmountMinor: domain.taxAmountMinor,
      discountAmountMinor: domain.discountAmountMinor,
      lineTotalMinor: domain.lineTotalMinor,
      status: domain.status,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: OrderLineEntity): OrderLine {
    return new OrderLine({
      id: entity.id === null || entity.id === undefined ? null : Number(entity.id),
      variantId: Number(entity.variantId),
      sku: entity.sku,
      nameSnapshot: entity.nameSnapshot,
      quantity: entity.quantity,
      cancelledQuantity: Number(entity.cancelledQuantity ?? 0),
      unitPriceMinor: Number(entity.unitPriceMinor),
      taxAmountMinor: Number(entity.taxAmountMinor),
      discountAmountMinor: Number(entity.discountAmountMinor),
      lineTotalMinor: Number(entity.lineTotalMinor),
      status: entity.status,
    });
  }
}
