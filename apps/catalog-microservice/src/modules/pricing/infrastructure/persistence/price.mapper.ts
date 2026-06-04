import { DeepPartial } from 'typeorm';

import { Price } from '../../domain';
import { PriceEntity } from './price.entity';

export class PriceMapper {
  public static toEntity(domain: Price): DeepPartial<PriceEntity> {
    const entity: DeepPartial<PriceEntity> = {
      variantId: domain.variantId,
      currency: domain.currency,
      amountMinor: domain.amountMinor,
      validFrom: domain.validFrom,
      validTo: domain.validTo,
      priority: domain.priority,
    };

    // Omit a null id so TypeORM treats the row as an insert (append-only — a
    // closed predecessor is updated only via `appendPrice`'s in-transaction
    // `valid_to` UPDATE, never re-saved through this mapper).
    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: PriceEntity): Price {
    return Price.reconstitute({
      id: entity.id,
      // `variant_id` and `amount_minor` are BIGINT columns; the mysql2 driver
      // returns non-PK BIGINTs as strings (the same reason the stock repository
      // coerces with `Number()`), so coerce them back to numbers here. The
      // BIGINT PK comes back as a number via `@PrimaryGeneratedColumn()`.
      variantId: Number(entity.variantId),
      currency: entity.currency,
      amountMinor: Number(entity.amountMinor),
      validFrom: entity.validFrom,
      validTo: entity.validTo,
      priority: entity.priority,
    });
  }
}
