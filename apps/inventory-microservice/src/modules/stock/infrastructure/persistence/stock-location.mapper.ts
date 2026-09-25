import { DeepPartial } from 'typeorm';

import { StockLocation } from '../../domain';
import { StockLocationEntity } from './stock-location.entity';

export class StockLocationMapper {
  public static toDomain(entity: StockLocationEntity): StockLocation {
    return new StockLocation({
      id: entity.id,
      name: entity.name,
      code: entity.code,
      type: entity.type,
      address: entity.address ?? null,
      gln: entity.gln ?? null,
      active: entity.active,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  public static toEntity(domain: StockLocation): DeepPartial<StockLocationEntity> {
    return {
      id: domain.id,
      name: domain.name,
      code: domain.code,
      type: domain.type,
      address: domain.address,
      gln: domain.gln,
      active: domain.active,
    };
  }
}
