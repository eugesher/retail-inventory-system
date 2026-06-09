import { DeepPartial } from 'typeorm';

import { StockLevel } from '../../domain';
import { StockLevelEntity } from './stock-level.entity';

export class StockLevelMapper {
  public static toDomain(entity: StockLevelEntity): StockLevel {
    return new StockLevel({
      id: entity.id,
      // `variant_id` is a BIGINT column; the mysql2 driver returns non-PK
      // BIGINTs as strings, so coerce back to a number (same reason the pricing
      // mapper uses `Number(...)`). The BIGINT PK comes back as a number via
      // `@PrimaryGeneratedColumn()`.
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

    // Omit a null id so TypeORM treats the row as an insert. `version` is owned
    // by TypeORM's `@VersionColumn` — it is intentionally NOT written here, so
    // the managed optimistic-lock token is never raced by a manual value.
    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }
}
