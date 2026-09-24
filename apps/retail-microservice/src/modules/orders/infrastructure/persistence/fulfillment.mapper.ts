import { DeepPartial } from 'typeorm';

import { Fulfillment } from '../../domain';
import { FulfillmentEntity } from './fulfillment.entity';
import { FulfillmentLineMapper } from './fulfillment-line.mapper';

export class FulfillmentMapper {
  public static toEntity(domain: Fulfillment): DeepPartial<FulfillmentEntity> {
    const entity: DeepPartial<FulfillmentEntity> = {
      orderId: domain.orderId,
      stockLocationId: domain.stockLocationId,
      status: domain.status,
      trackingNumber: domain.trackingNumber,
      carrier: domain.carrier,
      shippedAt: domain.shippedAt,
      deliveredAt: domain.deliveredAt,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: FulfillmentEntity): Fulfillment {
    const fulfillmentId = Number(entity.id);
    return Fulfillment.reconstitute({
      id: fulfillmentId,
      orderId: Number(entity.orderId),
      stockLocationId: entity.stockLocationId,
      status: entity.status,
      trackingNumber: entity.trackingNumber ?? null,
      carrier: entity.carrier ?? null,
      shippedAt: entity.shippedAt ?? null,
      deliveredAt: entity.deliveredAt ?? null,
      lines: (entity.lines ?? []).map((line) =>
        FulfillmentLineMapper.toDomain(line, fulfillmentId),
      ),
      version: Number(entity.version),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
