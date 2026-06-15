import { DeepPartial } from 'typeorm';

import { Fulfillment } from '../../domain';
import { FulfillmentEntity } from './fulfillment.entity';
import { FulfillmentLineMapper } from './fulfillment-line.mapper';

export class FulfillmentMapper {
  // Maps the root only — lines are persisted explicitly by the repository, so this
  // partial carries no `lines` array. `id` is omitted when null so TypeORM inserts;
  // present so it updates. `version` is intentionally NOT written — TypeORM's
  // `@VersionColumn` owns the persisted value (the same omission `OrderMapper` /
  // `StockLevelMapper` make), so the managed optimistic-lock token is never raced by
  // a manual value.
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
    // The BIGINT PK comes back as a number; coerce defensively (mysql2 returns non-PK
    // BIGINTs as strings, and the lines need the concrete parent id).
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
      // `version` is INT, returned as a number; coerce defensively for parity.
      version: Number(entity.version),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
