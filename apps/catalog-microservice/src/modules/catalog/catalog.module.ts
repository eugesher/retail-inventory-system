import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import { MicroserviceClientCatalogModule } from '@retail-inventory-system/messaging';

import {
  ACTIVE_PRICE_PROBE,
  CATALOG_DEFAULT_CURRENCY,
  CATALOG_EVENTS_PUBLISHER,
  CATALOG_REPOSITORY,
} from './application/ports';
import {
  AddVariantUseCase,
  ArchiveProductUseCase,
  GetProductBySlugUseCase,
  GetVariantUseCase,
  ListProductsUseCase,
  PublishProductUseCase,
  RegisterProductUseCase,
} from './application/use-cases';
import { CatalogRabbitmqPublisher } from './infrastructure/messaging';
import {
  ActivePriceProbeTypeormAdapter,
  CatalogTypeormRepository,
  ProductEntity,
  ProductVariantEntity,
} from './infrastructure/persistence';
import { CatalogController, CatalogRpcExceptionFilter } from './presentation';

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
// `catalog_queue` `ClientProxy` the publisher injects; the `forFeature` array is
// the entity-classes literal (the loose `catalogEntities` const type does not
// satisfy `forFeature`).
@Module({
  imports: [
    DatabaseModule.forFeature([ProductEntity, ProductVariantEntity]),
    MicroserviceClientCatalogModule,
  ],
  controllers: [CatalogController],
  providers: [
    // Maps every `CatalogDomainException` onto a wire error carrying an HTTP
    // `statusCode`, so the gateway resolves not-found → 404, taken/illegal-state
    // → 409, and bad input → 400 instead of collapsing all of them to 500
    // (ADR-025). Registered via APP_FILTER so it applies however the microservice
    // is bootstrapped (main.ts or the e2e `createMicroservice(AppModule)`).
    { provide: APP_FILTER, useClass: CatalogRpcExceptionFilter },

    CatalogTypeormRepository,
    { provide: CATALOG_REPOSITORY, useExisting: CatalogTypeormRepository },

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
  ],
})
export class CatalogModule {}
