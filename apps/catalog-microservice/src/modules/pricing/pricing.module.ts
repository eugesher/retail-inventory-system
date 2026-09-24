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
import { PricingTypeormRepository, pricingEntities } from './infrastructure/persistence';
import { PricingController, PricingRpcExceptionFilter } from './presentation';

@Module({
  imports: [
    DatabaseModule.forFeature(pricingEntities),
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
