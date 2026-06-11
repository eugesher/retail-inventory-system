import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  CategoryReparentView,
  CategoryView,
  ICreateCategoryPayload,
  IReparentCategoryPayload,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { CreateCategoryUseCase, ReparentCategoryUseCase } from '../application/use-cases';

// Thin RMQ entry points for the category write path, on `catalog_queue`. A
// SEPARATE controller from `catalog.controller.ts` keeps each file
// one-aggregate-shaped (Product vs. Category); the `APP_FILTER`-registered
// `CatalogRpcExceptionFilter` already covers every controller in the module, so
// the `CATEGORY_*` codes map to HTTP without extra wiring. The handlers translate
// the wire payload into the use-case call; `correlationId` is logged inline inside
// each use case (`PinoLogger.assign()` throws outside request scope — ADR-001 /
// ADR-011), so the controller carries no logging of its own.
@Controller()
export class CategoryController {
  constructor(
    private readonly createCategoryUseCase: CreateCategoryUseCase,
    private readonly reparentCategoryUseCase: ReparentCategoryUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.CATALOG_CATEGORY_CREATE)
  public async createCategory(@Payload() payload: ICreateCategoryPayload): Promise<CategoryView> {
    return this.createCategoryUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_CATEGORY_REPARENT)
  public async reparentCategory(
    @Payload() payload: IReparentCategoryPayload,
  ): Promise<CategoryReparentView> {
    return this.reparentCategoryUseCase.execute(payload);
  }
}
