import { DeepPartial } from 'typeorm';

import { StockLevel } from '../../domain';
import { StockLevelEntity } from './stock-level.entity';

export class StockLevelMapper {
  public static toDomain(entity: StockLevelEntity): StockLevel {
    return new StockLevel({
      id: entity.id,
      variantId: Number(entity.variantId),
      stockLocationId: entity.stockLocationId,
      quantityOnHand: entity.quantityOnHand,
      quantityAllocated: entity.quantityAllocated,
      quantityReserved: entity.quantityReserved,
      version: Number(entity.version),
      updatedAt: entity.updatedAt ?? null,
    });
  }

  public static toEntity(domain: StockLevel): DeepPartial<StockLevelEntity> {
    const entity: DeepPartial<StockLevelEntity> = {
      variantId: domain.variantId,
      stockLocationId: domain.stockLocationId,
      quantityOnHand: domain.quantityOnHand,
      quantityAllocated: domain.quantityAllocated,
      quantityReserved: domain.quantityReserved,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }
}
