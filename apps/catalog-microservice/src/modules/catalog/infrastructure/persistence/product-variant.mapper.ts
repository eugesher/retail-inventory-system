import { DeepPartial } from 'typeorm';

import { ProductVariant } from '../../domain';
import { ProductVariantEntity } from './product-variant.entity';

export class ProductVariantMapper {
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
