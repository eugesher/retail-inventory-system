import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MicroserviceClientCatalogModule } from '@retail-inventory-system/messaging';

import { CATALOG_GATEWAY_DEFAULT_CURRENCY, CATALOG_GATEWAY_PORT } from './application/ports';
import {
  AddVariantUseCase,
  ArchiveProductUseCase,
  AttachMediaUseCase,
  AttachProductCategoriesUseCase,
  AttachVariantTaxCategoryUseCase,
  CreateCategoryUseCase,
  CreateTaxCategoryUseCase,
  DetachMediaUseCase,
  DetachProductCategoryUseCase,
  GetApplicablePriceUseCase,
  GetCategoryTreeUseCase,
  GetProductUseCase,
  GetVariantUseCase,
  ListCategoriesUseCase,
  ListCategoryProductsUseCase,
  ListMediaUseCase,
  ListPricesUseCase,
  ListProductsUseCase,
  ListTaxCategoriesUseCase,
  PublishProductUseCase,
  RegisterProductUseCase,
  ReorderMediaUseCase,
  ReparentCategoryUseCase,
  SetPriceUseCase,
} from './application/use-cases';
import { CatalogRabbitmqAdapter } from './infrastructure/messaging';
import { CatalogController, CategoryController, MediaController } from './presentation';

@Module({
  imports: [MicroserviceClientCatalogModule],
  controllers: [CatalogController, CategoryController, MediaController],
  providers: [
    // The currency the price-read endpoints scope to when the caller omits `?currency=`, resolved from
    // the SAME `DEFAULT_CURRENCY` var the catalog prices against and the cart opens in (ISSUE-11).
    // `PriceQueryDto` used to default it to a literal `'USD'`, so a shop configured for EUR asked for a
    // currency its catalog does not stock and displayed no prices at all. `ConfigModule` is global, so
    // `ConfigService` injects here without a per-module import. The `?? 'USD'` matters only if the env
    // is bypassed entirely (a unit boot without config) — the `cart.module.ts` precedent.
    {
      provide: CATALOG_GATEWAY_DEFAULT_CURRENCY,
      useFactory: (config: ConfigService): string =>
        config.get<string>('DEFAULT_CURRENCY') ?? 'USD',
      inject: [ConfigService],
    },

    RegisterProductUseCase,
    AddVariantUseCase,
    PublishProductUseCase,
    ArchiveProductUseCase,
    ListProductsUseCase,
    GetProductUseCase,
    GetVariantUseCase,
    SetPriceUseCase,
    ListPricesUseCase,
    GetApplicablePriceUseCase,
    CreateTaxCategoryUseCase,
    ListTaxCategoriesUseCase,
    AttachVariantTaxCategoryUseCase,
    CreateCategoryUseCase,
    ReparentCategoryUseCase,
    ListCategoriesUseCase,
    GetCategoryTreeUseCase,
    ListCategoryProductsUseCase,
    AttachProductCategoriesUseCase,
    DetachProductCategoryUseCase,
    AttachMediaUseCase,
    ReorderMediaUseCase,
    DetachMediaUseCase,
    ListMediaUseCase,
    { provide: CATALOG_GATEWAY_PORT, useClass: CatalogRabbitmqAdapter },
  ],
})
export class CatalogModule {}
