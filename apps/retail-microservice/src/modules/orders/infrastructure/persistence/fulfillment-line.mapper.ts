import { DeepPartial } from 'typeorm';

import { FulfillmentLine } from '../../domain';
import { FulfillmentEntity } from './fulfillment.entity';
import { FulfillmentLineEntity } from './fulfillment-line.entity';

export class FulfillmentLineMapper {
  // `fulfillmentId` is supplied by the repository (the root's generated BIGINT id); a
  // fulfillment line never stands alone. The FK is set through the `fulfillment`
  // relation reference `{ id: fulfillmentId }` — TypeORM writes `fulfillment_id` from
  // it without cascading to (or touching) the `fulfillment` table. Omit a null id so
  // TypeORM inserts the row; pass the concrete id so an existing line is updated.
  public static toEntity(
    domain: FulfillmentLine,
    fulfillmentId: number,
  ): DeepPartial<FulfillmentLineEntity> {
    const entity: DeepPartial<FulfillmentLineEntity> = {
      fulfillment: { id: fulfillmentId } as FulfillmentEntity,
      orderLineId: domain.orderLineId,
      quantity: domain.quantity,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  // The parent id is passed in (the repository knows it from the loaded root) rather
  // than read off `entity.fulfillment`, since the inverse relation is not populated
  // when the root is loaded with `relations: { lines: true }`. `order_line_id` is
  // BIGINT — mysql2 returns non-PK BIGINTs as strings, so coerce back to a number
  // (the order/stock-level mapper idiom).
  public static toDomain(entity: FulfillmentLineEntity, fulfillmentId: number): FulfillmentLine {
    return new FulfillmentLine({
      id: entity.id === null || entity.id === undefined ? null : Number(entity.id),
      fulfillmentId,
      orderLineId: Number(entity.orderLineId),
      quantity: entity.quantity,
    });
  }
}
