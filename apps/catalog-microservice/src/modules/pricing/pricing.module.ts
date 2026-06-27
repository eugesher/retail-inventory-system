import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientCatalogModule,
  MicroserviceClientRisEventsModule,
} from '@retail-inventory-system/messaging';

import { PRICING_EVENTS_PUBLISHER, PRICING_REPOSITORY } from './application/ports';
import {
  AttachTaxCategoryToVariantUseCase,
  CreateTaxCategoryUseCase,
  ListPricesUseCase,
  ListTaxCategoriesUseCase,
  SelectApplicablePriceUseCase,
  SetPriceUseCase,
} from './application/use-cases';
import { PricingRabbitmqPublisher } from './infrastructure/messaging';
import {
  PriceEntity,
  PricingTypeormRepository,
  TaxCategoryEntity,
} from './infrastructure/persistence';
import { PricingController, PricingRpcExceptionFilter } from './presentation';

// The pricing bounded context colocates with the catalog microservice — it shares
// `catalog_queue` and keys on the same `variantId` backbone (ADR-025 / ADR-026)
// rather than standing up a new deployable. It mirrors `catalog.module.ts`'s one
// divergence from the canonical template: the Nest module file sits at the module
// root.
//
// `useExisting` shares the single adapter instance with code that injects the
// concrete class directly, while use cases depend on the port symbols
// (`PRICING_REPOSITORY`, `PRICING_EVENTS_PUBLISHER`).
// `MicroserviceClientCatalogModule` provides the `catalog_queue` `ClientProxy` the
// publisher injects; `MicroserviceClientRisEventsModule` provides the `ris.events`
// topic-exchange client so the publisher can mirror every pricing event onto the
// event-store firehose (ADR-035, the `RisEventsMirrorPublisher` dual-publish). The
// `PricingRpcExceptionFilter` is registered via `APP_FILTER` so it applies however
// the microservice is bootstrapped (main.ts or the e2e
// `createMicroservice(AppModule)`). No `CacheModule`: the threshold for caching
// pricing reads is unmet, so the reserved `catalogPrice*` builder stays unconsumed
// (ADR-026).
@Module({
  imports: [
    DatabaseModule.forFeature([PriceEntity, TaxCategoryEntity]),
    MicroserviceClientCatalogModule,
    MicroserviceClientRisEventsModule,
  ],
  controllers: [PricingController],
  providers: [
    { provide: APP_FILTER, useClass: PricingRpcExceptionFilter },

    PricingTypeormRepository,
    { provide: PRICING_REPOSITORY, useExisting: PricingTypeormRepository },

    PricingRabbitmqPublisher,
    { provide: PRICING_EVENTS_PUBLISHER, useExisting: PricingRabbitmqPublisher },

    SetPriceUseCase,
    ListPricesUseCase,
    SelectApplicablePriceUseCase,
    CreateTaxCategoryUseCase,
    ListTaxCategoriesUseCase,
    AttachTaxCategoryToVariantUseCase,
  ],
})
export class PricingModule {}
