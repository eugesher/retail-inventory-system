import { DeepPartial } from 'typeorm';

import { Product } from '../../domain';
import { ProductEntity } from './product.entity';
import { ProductVariantMapper } from './product-variant.mapper';

export class ProductMapper {
  // Maps the root only — variants are persisted separately (cascade off), so
  // the repository writes the `product` row first to obtain the id and then
  // maps each child with `ProductVariantMapper.toEntity(variant, productId)`.
  public static toEntity(domain: Product): DeepPartial<ProductEntity> {
    const entity: DeepPartial<ProductEntity> = {
      name: domain.name,
      slug: domain.slug,
      description: domain.description,
      status: domain.status,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: ProductEntity): Product {
    return Product.reconstitute({
      id: entity.id,
      name: entity.name,
      // `description` is nullable in the DB; the domain models its absence as
      // an empty string, so map a null column to `undefined` and let the
      // aggregate default it.
      description: entity.description ?? undefined,
      slug: entity.slug,
      status: entity.status,
      variants: (entity.variants ?? []).map((variant) => ProductVariantMapper.toDomain(variant)),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
