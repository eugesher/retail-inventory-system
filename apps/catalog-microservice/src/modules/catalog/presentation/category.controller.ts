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
