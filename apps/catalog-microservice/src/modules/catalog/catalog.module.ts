import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientCatalogModule,
  MicroserviceClientInventoryModule,
  MicroserviceClientRisEventsModule,
} from '@retail-inventory-system/messaging';

import {
  ACTIVE_PRICE_PROBE,
  CATALOG_DEFAULT_CURRENCY,
  CATALOG_EVENTS_PUBLISHER,
  CATALOG_REPOSITORY,
  CATEGORY_REPOSITORY,
  MEDIA_ASSET_REPOSITORY,
} from './application/ports';
import {
  AddVariantUseCase,
  ArchiveProductUseCase,
  AttachMediaUseCase,
  CreateCategoryUseCase,
  DetachMediaUseCase,
  GetCategoryTreeUseCase,
  GetProductBySlugUseCase,
  GetVariantUseCase,
  ListCategoriesUseCase,
  ListCategoryProductsUseCase,
  ListMediaUseCase,
  ListProductsUseCase,
  PublishProductUseCase,
  ReclassifyProductUseCase,
  RegisterProductUseCase,
  ReorderMediaUseCase,
  ReparentCategoryUseCase,
} from './application/use-cases';
import { CatalogRabbitmqPublisher } from './infrastructure/messaging';
import {
  ActivePriceProbeTypeormAdapter,
  CatalogTypeormRepository,
  CategoryTypeormRepository,
  MediaAssetTypeormRepository,
  catalogEntities,
} from './infrastructure/persistence';
import {
  CatalogController,
  CatalogRpcExceptionFilter,
  CategoryController,
  MediaController,
} from './presentation';

const DEFAULT_CURRENCY_PROVIDER = {
  provide: CATALOG_DEFAULT_CURRENCY,
  useFactory: (config: ConfigService): string => config.get<string>('DEFAULT_CURRENCY') ?? 'USD',
  inject: [ConfigService],
};

@Module({
  imports: [
    DatabaseModule.forFeature(catalogEntities),
    MicroserviceClientCatalogModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientRisEventsModule,
  ],
  controllers: [CatalogController, CategoryController, MediaController],
  providers: [
    { provide: APP_FILTER, useClass: CatalogRpcExceptionFilter },

    CatalogTypeormRepository,
    { provide: CATALOG_REPOSITORY, useExisting: CatalogTypeormRepository },

    CategoryTypeormRepository,
    { provide: CATEGORY_REPOSITORY, useExisting: CategoryTypeormRepository },

    MediaAssetTypeormRepository,
    { provide: MEDIA_ASSET_REPOSITORY, useExisting: MediaAssetTypeormRepository },

    CatalogRabbitmqPublisher,
    { provide: CATALOG_EVENTS_PUBLISHER, useExisting: CatalogRabbitmqPublisher },

    ActivePriceProbeTypeormAdapter,
    { provide: ACTIVE_PRICE_PROBE, useExisting: ActivePriceProbeTypeormAdapter },
    DEFAULT_CURRENCY_PROVIDER,

    RegisterProductUseCase,
    AddVariantUseCase,
    PublishProductUseCase,
    ArchiveProductUseCase,
    ListProductsUseCase,
    GetProductBySlugUseCase,
    GetVariantUseCase,

    CreateCategoryUseCase,
    ReparentCategoryUseCase,
    ListCategoriesUseCase,
    GetCategoryTreeUseCase,
    ListCategoryProductsUseCase,
    ReclassifyProductUseCase,

    AttachMediaUseCase,
    ReorderMediaUseCase,
    DetachMediaUseCase,
    ListMediaUseCase,
  ],
})
export class CatalogModule {}
