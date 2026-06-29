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
  CategoryEntity,
  CategoryTypeormRepository,
  MediaAssetEntity,
  MediaAssetTypeormRepository,
  ProductEntity,
  ProductVariantEntity,
} from './infrastructure/persistence';
import {
  CatalogController,
  CatalogRpcExceptionFilter,
  CategoryController,
  MediaController,
} from './presentation';

// The currency the publish precondition resolves against. `ConfigModule` is
// global (registered at the app root), so `ConfigService` injects here without a
// per-module import. The Joi schema defaults `DEFAULT_CURRENCY` to `USD`, so the
// `?? 'USD'` fallback only matters if the env is bypassed entirely (e.g. a unit
// boot without config).
const DEFAULT_CURRENCY_PROVIDER = {
  provide: CATALOG_DEFAULT_CURRENCY,
  useFactory: (config: ConfigService): string => config.get<string>('DEFAULT_CURRENCY') ?? 'USD',
  inject: [ConfigService],
};

// `useExisting` shares the single adapter instance with code that injects the
// concrete class directly, while consumers depend on the port symbols
// (`CATALOG_REPOSITORY`, `CATALOG_EVENTS_PUBLISHER`) — mirrors `stock.module.ts`
// / `orders.module.ts`. `MicroserviceClientCatalogModule` provides the
// `catalog_queue` `ClientProxy` for the reserved `catalog.product.*` events;
// `MicroserviceClientInventoryModule` provides the `inventory_queue` `ClientProxy`
// the publisher emits `catalog.variant.created` through (producer-targets-
// consumer-queue — the inventory auto-init consumer listens there, ADR-008/020).
// `MicroserviceClientRisEventsModule` provides the `ris.events` topic-exchange
// client so the publisher can mirror every catalog event onto the event-store
// firehose (ADR-035, the `RisEventsMirrorPublisher` dual-publish). The
// `forFeature` array is the entity-classes literal (the loose `catalogEntities`
// const type does not satisfy `forFeature`).
@Module({
  imports: [
    DatabaseModule.forFeature([
      ProductEntity,
      ProductVariantEntity,
      CategoryEntity,
      MediaAssetEntity,
    ]),
    MicroserviceClientCatalogModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientRisEventsModule,
  ],
  controllers: [CatalogController, CategoryController, MediaController],
  providers: [
    // Maps every `CatalogDomainException` onto a wire error carrying an HTTP
    // `statusCode`, so the gateway resolves not-found → 404, taken/illegal-state
    // → 409, and bad input → 400 instead of collapsing all of them to 500
    // (ADR-025). Registered via APP_FILTER so it applies however the microservice
    // is bootstrapped (main.ts or the e2e `createMicroservice(AppModule)`).
    { provide: APP_FILTER, useClass: CatalogRpcExceptionFilter },

    CatalogTypeormRepository,
    { provide: CATALOG_REPOSITORY, useExisting: CatalogTypeormRepository },

    // The Category aggregate's own repository seam (a separate port from
    // `CATALOG_REPOSITORY` — one port per aggregate, ADR-029 §8). Consumed by the
    // category write use cases (create / reparent) registered below.
    CategoryTypeormRepository,
    { provide: CATEGORY_REPOSITORY, useExisting: CategoryTypeormRepository },

    // The MediaAsset aggregate's own repository seam (a third separate port,
    // alongside `CATALOG_REPOSITORY` / `CATEGORY_REPOSITORY` — one port per
    // aggregate, ADR-029 §8). Consumed by the media use cases registered below;
    // attach also injects `CATALOG_REPOSITORY` for the polymorphic owner-existence
    // probe (no FK on `media_asset.owner_id`).
    MediaAssetTypeormRepository,
    { provide: MEDIA_ASSET_REPOSITORY, useExisting: MediaAssetTypeormRepository },

    CatalogRabbitmqPublisher,
    { provide: CATALOG_EVENTS_PUBLISHER, useExisting: CatalogRabbitmqPublisher },

    // The publish precondition seam: the probe reads the pricing-owned `price`
    // table via a parameterized query (no pricing import — ADR-017), and the
    // currency it resolves against comes from `DEFAULT_CURRENCY`.
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

    // Category write + read use cases + the product reclassify — all served by
    // `CategoryController` on `catalog_queue`. Reclassify spans both repository
    // seams (product existence + the `product_categories` membership), and the
    // category-scoped browse reuses `CATALOG_REPOSITORY` for the product read.
    CreateCategoryUseCase,
    ReparentCategoryUseCase,
    ListCategoriesUseCase,
    GetCategoryTreeUseCase,
    ListCategoryProductsUseCase,
    ReclassifyProductUseCase,

    // Media use cases — all served by `MediaController` on `catalog_queue`. Attach
    // spans both the media and catalog repository seams (owner existence + the
    // media write); reorder / detach / list touch only the media seam.
    AttachMediaUseCase,
    ReorderMediaUseCase,
    DetachMediaUseCase,
    ListMediaUseCase,
  ],
})
export class CatalogModule {}
