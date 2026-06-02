import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IArchiveProductPayload,
  ICreateVariantPayload,
  IPublishProductPayload,
  IRegisterProductPayload,
  ProductVariantView,
  ProductView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  AddVariantUseCase,
  ArchiveProductUseCase,
  PublishProductUseCase,
  RegisterProductUseCase,
} from '../application/use-cases';

// Thin RMQ entry points for the catalog write path. The handlers translate the
// wire payload into the use-case call; `correlationId` is logged inline inside
// each use case (`PinoLogger.assign()` throws outside request scope — ADR-001 /
// ADR-011), so the controller carries no logging of its own.
@Controller()
export class CatalogController {
  constructor(
    private readonly registerProductUseCase: RegisterProductUseCase,
    private readonly addVariantUseCase: AddVariantUseCase,
    private readonly publishProductUseCase: PublishProductUseCase,
    private readonly archiveProductUseCase: ArchiveProductUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.CATALOG_PRODUCT_REGISTER)
  public async registerProduct(@Payload() payload: IRegisterProductPayload): Promise<ProductView> {
    return this.registerProductUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_VARIANT_CREATE)
  public async createVariant(
    @Payload() payload: ICreateVariantPayload,
  ): Promise<ProductVariantView> {
    return this.addVariantUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_PRODUCT_PUBLISH)
  public async publishProduct(@Payload() payload: IPublishProductPayload): Promise<ProductView> {
    return this.publishProductUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_PRODUCT_ARCHIVE)
  public async archiveProduct(@Payload() payload: IArchiveProductPayload): Promise<ProductView> {
    return this.archiveProductUseCase.execute(payload);
  }
}
