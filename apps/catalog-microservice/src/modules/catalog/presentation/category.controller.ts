import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  CategoryReparentView,
  CategoryTreeNodeView,
  CategoryView,
  ICategoryListQuery,
  ICategoryProductsQuery,
  ICategoryTreeQuery,
  ICreateCategoryPayload,
  IPage,
  IReclassifyProductPayload,
  IReparentCategoryPayload,
  ProductCategoriesView,
  ProductWithVariantsView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  CreateCategoryUseCase,
  GetCategoryTreeUseCase,
  ListCategoriesUseCase,
  ListCategoryProductsUseCase,
  ReclassifyProductUseCase,
  ReparentCategoryUseCase,
} from '../application/use-cases';

// Thin RMQ entry points for the category write + read paths, on `catalog_queue`.
// A SEPARATE controller from `catalog.controller.ts` keeps each file
// one-aggregate-shaped (Product vs. Category); the `APP_FILTER`-registered
// `CatalogRpcExceptionFilter` already covers every controller in the module, so
// the `CATEGORY_*` / `PRODUCT_*` codes map to HTTP without extra wiring. The
// handlers translate the wire payload into the use-case call; `correlationId` is
// logged inline inside each use case (`PinoLogger.assign()` throws outside request
// scope — ADR-001 / ADR-011), so the controller carries no logging of its own.
//
// `catalog.product.reclassify` is a `product.*` key served HERE rather than on the
// product controller — the operation's subject is the product's CATEGORY
// membership, not the product header (the `retail.cart.place`-served-by-orders
// precedent).
@Controller()
export class CategoryController {
  constructor(
    private readonly createCategoryUseCase: CreateCategoryUseCase,
    private readonly reparentCategoryUseCase: ReparentCategoryUseCase,
    private readonly listCategoriesUseCase: ListCategoriesUseCase,
    private readonly getCategoryTreeUseCase: GetCategoryTreeUseCase,
    private readonly listCategoryProductsUseCase: ListCategoryProductsUseCase,
    private readonly reclassifyProductUseCase: ReclassifyProductUseCase,
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

  @MessagePattern(ROUTING_KEYS.CATALOG_CATEGORY_LIST)
  public async listCategories(@Payload() query: ICategoryListQuery): Promise<CategoryView[]> {
    return this.listCategoriesUseCase.execute(query);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_CATEGORY_GET_TREE)
  public async getCategoryTree(
    @Payload() query: ICategoryTreeQuery,
  ): Promise<CategoryTreeNodeView> {
    return this.getCategoryTreeUseCase.execute(query);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_CATEGORY_LIST_PRODUCTS)
  public async listCategoryProducts(
    @Payload() query: ICategoryProductsQuery,
  ): Promise<IPage<ProductWithVariantsView>> {
    return this.listCategoryProductsUseCase.execute(query);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_PRODUCT_RECLASSIFY)
  public async reclassifyProduct(
    @Payload() payload: IReclassifyProductPayload,
  ): Promise<ProductCategoriesView> {
    return this.reclassifyProductUseCase.execute(payload);
  }
}
