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

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: PriceEntity): Price {
    return Price.reconstitute({
      id: entity.id,
      variantId: Number(entity.variantId),
      currency: entity.currency,
      amountMinor: Number(entity.amountMinor),
      validFrom: entity.validFrom,
      validTo: entity.validTo,
      priority: entity.priority,
    });
  }
}
