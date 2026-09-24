import { DeepPartial } from 'typeorm';

import { FulfillmentLine } from '../../domain';
import { FulfillmentEntity } from './fulfillment.entity';
import { FulfillmentLineEntity } from './fulfillment-line.entity';

export class FulfillmentLineMapper {
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

  public static toDomain(entity: FulfillmentLineEntity, fulfillmentId: number): FulfillmentLine {
    return new FulfillmentLine({
      id: entity.id === null || entity.id === undefined ? null : Number(entity.id),
      fulfillmentId,
      orderLineId: Number(entity.orderLineId),
      quantity: entity.quantity,
    });
  }
}
