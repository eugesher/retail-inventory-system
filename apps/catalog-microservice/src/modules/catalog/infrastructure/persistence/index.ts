import { CategoryEntity } from './category.entity';
import { MediaAssetEntity } from './media-asset.entity';
import { ProductEntity } from './product.entity';
import { ProductVariantEntity } from './product-variant.entity';

// The module's entity list: `DatabaseModule.forRoot(...)` in `app.module.ts`, and
// `forFeature(...)` in the module file. UNANNOTATED on purpose — see the note on
// `DatabaseModule.forRoot` for why the parameter type must not be used here.
export const catalogEntities = [
  ProductEntity,
  ProductVariantEntity,
  CategoryEntity,
  MediaAssetEntity,
];

export { CategoryEntity, MediaAssetEntity, ProductEntity, ProductVariantEntity };
export * from './category.mapper';
export * from './category-typeorm.repository';
export * from './media-asset.mapper';
export * from './media-asset-typeorm.repository';
export * from './product.mapper';
export * from './product-variant.mapper';
export * from './catalog-typeorm.repository';
export * from './active-price-probe.typeorm.adapter';
