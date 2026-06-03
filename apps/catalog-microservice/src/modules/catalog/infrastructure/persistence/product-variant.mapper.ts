import { DeepPartial } from 'typeorm';

import { ProductVariant } from '../../domain';
import { ProductVariantEntity } from './product-variant.entity';

export class ProductVariantMapper {
  // The domain getters already expose the raw shapes persistence wants
  // (`optionValues` as a plain map, `dimensionsMm` as `{l,w,h}|null`), so the
  // value objects never cross the boundary. `productId` is supplied by the
  // repository after the parent save assigns the product id — a freshly added
  // variant still carries a null `productId` on the aggregate.
  public static toEntity(
    domain: ProductVariant,
    productId: number,
  ): DeepPartial<ProductVariantEntity> {
    const entity: DeepPartial<ProductVariantEntity> = {
      productId,
      sku: domain.sku,
      gtin: domain.gtin,
      optionValues: domain.optionValues,
      weightG: domain.weightG,
      dimensionsMm: domain.dimensionsMm,
      status: domain.status,
    };

    // Omit a null id so TypeORM treats the row as an insert; pass the concrete
    // id so an existing variant is updated in place.
    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: ProductVariantEntity): ProductVariant {
    return new ProductVariant({
      id: entity.id,
      productId: entity.productId,
      sku: entity.sku,
      gtin: entity.gtin,
      optionValues: entity.optionValues,
      weightG: entity.weightG,
      dimensionsMm: entity.dimensionsMm,
      status: entity.status,
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
