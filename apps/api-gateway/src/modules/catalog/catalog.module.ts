import { Module } from '@nestjs/common';

import { MicroserviceClientCatalogModule } from '@retail-inventory-system/messaging';

import { CATALOG_GATEWAY_PORT } from './application/ports';
import {
  AddVariantUseCase,
  ArchiveProductUseCase,
  AttachVariantTaxCategoryUseCase,
  CreateTaxCategoryUseCase,
  GetApplicablePriceUseCase,
  GetProductUseCase,
  GetVariantUseCase,
  ListPricesUseCase,
  ListProductsUseCase,
  ListTaxCategoriesUseCase,
  PublishProductUseCase,
  RegisterProductUseCase,
  SetPriceUseCase,
} from './application/use-cases';
import { CatalogRabbitmqAdapter } from './infrastructure/messaging';
import { CatalogController } from './presentation';

@Module({
  imports: [MicroserviceClientCatalogModule],
  controllers: [CatalogController],
  providers: [
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
    { provide: CATALOG_GATEWAY_PORT, useClass: CatalogRabbitmqAdapter },
  ],
})
export class CatalogModule {}
