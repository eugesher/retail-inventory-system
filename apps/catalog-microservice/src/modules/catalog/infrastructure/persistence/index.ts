import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { ProductEntity } from './product.entity';
import { ProductVariantEntity } from './product-variant.entity';

export const catalogEntities: TypeOrmModuleOptions['entities'] = [
  ProductEntity,
  ProductVariantEntity,
];

export { ProductEntity, ProductVariantEntity };
export * from './product.mapper';
export * from './product-variant.mapper';
export * from './catalog-typeorm.repository';
export * from './active-price-probe.typeorm.adapter';
