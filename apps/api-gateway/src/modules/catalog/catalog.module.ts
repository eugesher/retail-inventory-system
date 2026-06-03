import { Module } from '@nestjs/common';

import { MicroserviceClientCatalogModule } from '@retail-inventory-system/messaging';

import { CATALOG_GATEWAY_PORT } from './application/ports';
import {
  AddVariantUseCase,
  ArchiveProductUseCase,
  GetProductUseCase,
  GetVariantUseCase,
  ListProductsUseCase,
  PublishProductUseCase,
  RegisterProductUseCase,
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
    { provide: CATALOG_GATEWAY_PORT, useClass: CatalogRabbitmqAdapter },
  ],
})
export class CatalogModule {}
