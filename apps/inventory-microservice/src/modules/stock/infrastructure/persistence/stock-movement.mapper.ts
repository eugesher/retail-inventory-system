import { DeepPartial } from 'typeorm';

import { StockMovement } from '../../domain';
import { StockMovementEntity } from './stock-movement.entity';

export class StockMovementMapper {
  public static toDomain(entity: StockMovementEntity): StockMovement {
    return StockMovement.reconstitute({
      // The BIGINT PK comes back as a number via `@PrimaryGeneratedColumn()`.
      id: entity.id,
      // `variant_id` is a non-PK BIGINT column; the mysql2 driver returns those as
      // strings, so coerce back to a number (the `StockLevelMapper` precedent).
      variantId: Number(entity.variantId),
      stockLocationId: entity.stockLocationId,
      type: entity.type,
      quantity: entity.quantity,
      reasonCode: entity.reasonCode ?? null,
      referenceType: entity.referenceType ?? null,
      referenceId: entity.referenceId ?? null,
      actorId: entity.actorId ?? null,
      occurredAt: entity.occurredAt,
    });
  }

  public static toEntity(domain: StockMovement): DeepPartial<StockMovementEntity> {
    // `id` is always null on the append path (DB-assigned), so it is never written
    // — TypeORM INSERTs the row. There is no update path: a movement is immutable
    // once recorded (the append-only ledger, ADR-030).
    return {
      variantId: domain.variantId,
      stockLocationId: domain.stockLocationId,
      type: domain.type,
      quantity: domain.quantity,
      reasonCode: domain.reasonCode,
      referenceType: domain.referenceType,
      referenceId: domain.referenceId,
      actorId: domain.actorId,
      occurredAt: domain.occurredAt,
    };
  }
}
