import { DeepPartial } from 'typeorm';

import { StockMovement } from '../../domain';
import { StockMovementEntity } from './stock-movement.entity';

export class StockMovementMapper {
  public static toDomain(entity: StockMovementEntity): StockMovement {
    return StockMovement.reconstitute({
      id: entity.id,
      variantId: Number(entity.variantId),
      stockLocationId: entity.stockLocationId,
      type: entity.type,
      quantity: entity.quantity,
      reasonCode: entity.reasonCode ?? null,
      referenceType: entity.referenceType ?? null,
      referenceId: entity.referenceId ?? null,
      actorId: entity.actorId ?? null,
      operationKey: entity.operationKey ?? null,
      occurredAt: entity.occurredAt,
    });
  }

  public static toEntity(domain: StockMovement): DeepPartial<StockMovementEntity> {
    return {
      variantId: domain.variantId,
      stockLocationId: domain.stockLocationId,
      type: domain.type,
      quantity: domain.quantity,
      reasonCode: domain.reasonCode,
      referenceType: domain.referenceType,
      referenceId: domain.referenceId,
      actorId: domain.actorId,
      operationKey: domain.operationKey,
      occurredAt: domain.occurredAt,
    };
  }
}
