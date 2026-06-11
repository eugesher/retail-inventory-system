import { Module } from '@nestjs/common';

import { MicroserviceClientCatalogModule } from '@retail-inventory-system/messaging';

import { CATALOG_GATEWAY_PORT } from './application/ports';
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
