import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { CATALOG_REPOSITORY } from './application/ports';
import {
  CatalogTypeormRepository,
  ProductEntity,
  ProductVariantEntity,
} from './infrastructure/persistence';

// `useExisting` shares the single adapter instance with code that injects the
// concrete class directly, while consumers depend on the `CATALOG_REPOSITORY`
// port symbol (mirrors `stock.module.ts`). The `forFeature` array is the entity
// classes literal (not the `catalogEntities` const, whose loose
// `TypeOrmModuleOptions['entities']` type does not satisfy `forFeature`). Use
// cases / controllers arrive in later work; today the module only stands up the
// persistence seam.
@Module({
  imports: [DatabaseModule.forFeature([ProductEntity, ProductVariantEntity])],
  providers: [
    CatalogTypeormRepository,
    { provide: CATALOG_REPOSITORY, useExisting: CatalogTypeormRepository },
  ],
})
export class CatalogModule {}
