import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { CategoryEntity } from './category.entity';
import { ProductEntity } from './product.entity';
import { ProductVariantEntity } from './product-variant.entity';

export const catalogEntities: TypeOrmModuleOptions['entities'] = [
  ProductEntity,
  ProductVariantEntity,
  CategoryEntity,
];

export { CategoryEntity, ProductEntity, ProductVariantEntity };
export * from './category.mapper';
export * from './category-typeorm.repository';
export * from './product.mapper';
export * from './product-variant.mapper';
export * from './catalog-typeorm.repository';
export * from './active-price-probe.typeorm.adapter';
