import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import { MicroserviceClientCatalogModule } from '@retail-inventory-system/messaging';

import { CATALOG_EVENTS_PUBLISHER, CATALOG_REPOSITORY } from './application/ports';
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
  CatalogTypeormRepository,
  ProductEntity,
  ProductVariantEntity,
} from './infrastructure/persistence';
import { CatalogController, CatalogRpcExceptionFilter } from './presentation';

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
