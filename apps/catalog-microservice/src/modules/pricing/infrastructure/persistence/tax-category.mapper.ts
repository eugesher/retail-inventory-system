import { DeepPartial } from 'typeorm';

import { TaxCategory } from '../../domain';
import { TaxCategoryEntity } from './tax-category.entity';

export class TaxCategoryMapper {
  public static toEntity(domain: TaxCategory): DeepPartial<TaxCategoryEntity> {
    const entity: DeepPartial<TaxCategoryEntity> = {
      code: domain.code,
      name: domain.name,
      description: domain.description,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: TaxCategoryEntity): TaxCategory {
    return TaxCategory.reconstitute({
      id: entity.id,
      code: entity.code,
      name: entity.name,
      description: entity.description,
    });
  }
}
