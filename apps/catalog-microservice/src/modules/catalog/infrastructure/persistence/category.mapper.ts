import { DeepPartial } from 'typeorm';

import { Category } from '../../domain';
import { CategoryEntity } from './category.entity';

export class CategoryMapper {
  public static toEntity(domain: Category): DeepPartial<CategoryEntity> {
    const entity: DeepPartial<CategoryEntity> = {
      name: domain.name,
      slug: domain.slug,
      parentId: domain.parentId,
      path: domain.path,
      sortOrder: domain.sortOrder,
      status: domain.status,
    };

    // Omit a null id so TypeORM treats the row as an insert; pass the concrete
    // id so an existing category is updated in place.
    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: CategoryEntity): Category {
    return Category.reconstitute({
      id: entity.id,
      name: entity.name,
      slug: entity.slug,
      // `parent_id` is a non-PK BIGINT, which mysql2 may surface as a string.
      // Coerce to a number while PRESERVING null — a root must stay null
      // (`Number(null)` is `0`, which would forge a child of category 0).
      parentId: entity.parentId === null ? null : Number(entity.parentId),
      path: entity.path,
      sortOrder: entity.sortOrder,
      status: entity.status,
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
