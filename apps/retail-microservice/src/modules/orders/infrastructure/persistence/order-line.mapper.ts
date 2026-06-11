import { DeepPartial } from 'typeorm';

import { OrderLine } from '../../domain';
import { OrderEntity } from './order.entity';
import { OrderLineEntity } from './order-line.entity';

export class OrderLineMapper {
  // `orderId` is supplied by the repository (the root's generated BIGINT id); an
  // order line never stands alone. The FK is set through the `order` relation
  // reference `{ id: orderId }` — TypeORM writes `order_id` from it without
  // cascading to (or touching) the `order` table. Omit a null id so TypeORM inserts
  // the row; pass the concrete id so an existing line is updated in place.
  public static toEntity(domain: OrderLine, orderId: number): DeepPartial<OrderLineEntity> {
    const entity: DeepPartial<OrderLineEntity> = {
      order: { id: orderId } as OrderEntity,
      variantId: domain.variantId,
      sku: domain.sku,
      nameSnapshot: domain.nameSnapshot,
      quantity: domain.quantity,
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
      // The BIGINT PK comes back as a number via `@PrimaryGeneratedColumn()`;
      // coerce defensively for parity with the BIGINT scalar coercions below.
      id: entity.id === null || entity.id === undefined ? null : Number(entity.id),
      // `variant_id` / the money columns are BIGINT; mysql2 returns non-PK BIGINTs
      // as strings, so coerce back to numbers (the stock-level / pricing mapper
      // idiom).
      variantId: Number(entity.variantId),
      sku: entity.sku,
      nameSnapshot: entity.nameSnapshot,
      quantity: entity.quantity,
      unitPriceMinor: Number(entity.unitPriceMinor),
      taxAmountMinor: Number(entity.taxAmountMinor),
      discountAmountMinor: Number(entity.discountAmountMinor),
      lineTotalMinor: Number(entity.lineTotalMinor),
      status: entity.status,
    });
  }
}
