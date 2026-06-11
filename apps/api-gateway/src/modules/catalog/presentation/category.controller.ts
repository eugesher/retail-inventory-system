import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { Public, RequiresPermission } from '@retail-inventory-system/auth';
import {
  CategoryReparentView,
  CategoryTreeNodeView,
  CategoryView,
  IPage,
  PermissionCodeEnum,
  ProductCategoriesView,
  ProductWithVariantsView,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  AttachProductCategoriesUseCase,
  CreateCategoryUseCase,
  DetachProductCategoryUseCase,
  GetCategoryTreeUseCase,
  ListCategoriesUseCase,
  ListCategoryProductsUseCase,
  ReparentCategoryUseCase,
} from '../application/use-cases';
import {
  AttachProductCategoriesRequestDto,
  CategoryProductsQueryDto,
  CreateCategoryRequestDto,
  ListCategoriesQueryDto,
  ReparentCategoryRequestDto,
} from './dto';

// HTTP surface over the catalog microservice's category RPCs (ADR-009/ADR-029).
// One-aggregate-shaped controller, separate from the product `CatalogController`
// (the auth module's multi-controller-per-prefix precedent). Write routes are
// permission-gated with `catalog:write` per ADR-024 — the SAME code that gates
// product authoring, no new permission is minted for the category surface;
// customer tokens carry no `permissions` claim, so writes are staff-only by
// construction. Read routes are `@Public()` so an unauthenticated shopper can
// browse the navigation tree. `catalog.product.reclassify` is a `product.*` RPC
// whose SUBJECT is the membership, so its two HTTP routes live here, not on
// `CatalogController`. Each method is a thin port→adapter pass to `catalog_queue`;
// the microservice's typed `CATEGORY_*` codes surface as 400/404/409 unchanged.
@ApiTags('Catalog')
@Controller('catalog')
export class CategoryController {
  constructor(
    private readonly createCategoryUseCase: CreateCategoryUseCase,
    private readonly reparentCategoryUseCase: ReparentCategoryUseCase,
    private readonly listCategoriesUseCase: ListCategoriesUseCase,
    private readonly getCategoryTreeUseCase: GetCategoryTreeUseCase,
    private readonly listCategoryProductsUseCase: ListCategoryProductsUseCase,
    private readonly attachProductCategoriesUseCase: AttachProductCategoriesUseCase,
    private readonly detachProductCategoryUseCase: DetachProductCategoryUseCase,
  ) {}

  @Post('categories')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a category (root or nested under a parent slug)' })
  @ApiCreatedResponse({ description: 'Category created', type: CategoryView })
  @ApiProduces('application/json')
  public async createCategory(
    @Body() dto: CreateCategoryRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<CategoryView> {
    return this.createCategoryUseCase.execute(dto, correlationId);
  }

  @Patch('categories/:slug/parent')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reparent a category and its subtree (null parent demotes to root)' })
  @ApiParam({ name: 'slug', type: String, example: 'shirts' })
  @ApiOkResponse({
    description: 'Category moved; `rewrittenDescendantCount` reports the rebased subtree size',
    type: CategoryReparentView,
  })
  @ApiProduces('application/json')
  public async reparentCategory(
    @Param('slug') slug: string,
    @Body() dto: ReparentCategoryRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<CategoryReparentView> {
    return this.reparentCategoryUseCase.execute(
      { slug, newParentSlug: dto.newParentSlug },
      correlationId,
    );
  }

  @Get('categories')
  @Public()
  @ApiOperation({ summary: 'List categories (flat, with materialized `path`)' })
  @ApiOkResponse({
    description: 'Active categories, ordered for navigation',
    type: CategoryView,
    isArray: true,
  })
  @ApiProduces('application/json')
  public async listCategories(
    @Query() query: ListCategoriesQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<CategoryView[]> {
    return this.listCategoriesUseCase.execute({ rootOnly: query.root }, correlationId);
  }

  @Get('categories/:slug/tree')
  @Public()
  @ApiOperation({ summary: 'Fetch a category with its nested active subtree' })
  @ApiParam({ name: 'slug', type: String, example: 'menswear' })
  @ApiExtraModels(CategoryTreeNodeView)
  @ApiOkResponse({ description: 'The category with nested `children`', type: CategoryTreeNodeView })
  @ApiProduces('application/json')
  public async getCategoryTree(
    @Param('slug') slug: string,
    @CorrelationId() correlationId: string,
  ): Promise<CategoryTreeNodeView> {
    return this.getCategoryTreeUseCase.execute(slug, correlationId);
  }

  @Get('categories/:slug/products')
  @Public()
  @ApiOperation({ summary: 'Browse the active products in a category (paginated)' })
  @ApiParam({ name: 'slug', type: String, example: 'menswear' })
  @ApiExtraModels(ProductWithVariantsView)
  @ApiOkResponse({
    description: 'Active products with their active variants, paginated',
    // The handler returns the `IPage` envelope ({ items, total, page, size }),
    // not a bare array — describe the real shape so generated clients read
    // `body.items` rather than indexing the response as an array.
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: getSchemaPath(ProductWithVariantsView) } },
        total: { type: 'integer', example: 1 },
        page: { type: 'integer', example: 1 },
        size: { type: 'integer', example: 20 },
      },
    },
  })
  @ApiProduces('application/json')
  public async listCategoryProducts(
    @Param('slug') slug: string,
    @Query() query: CategoryProductsQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<IPage<ProductWithVariantsView>> {
    return this.listCategoryProductsUseCase.execute({ ...query, slug }, correlationId);
  }

  @Post('products/:productId/categories')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  // A membership UPDATE, not a creation, so it returns 200 (not 201) — the
  // product/category rows already exist; the publish/archive precedent.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Attach a product to one or more categories' })
  @ApiParam({ name: 'productId', type: Number, example: 1 })
  @ApiOkResponse({
    description: 'The product with its FULL current category membership',
    type: ProductCategoriesView,
  })
  @ApiProduces('application/json')
  public async attachProductCategories(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() dto: AttachProductCategoriesRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<ProductCategoriesView> {
    return this.attachProductCategoriesUseCase.execute(
      { productId, categorySlugs: dto.categorySlugs },
      correlationId,
    );
  }

  @Delete('products/:productId/categories/:categorySlug')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detach a product from a category (idempotent)' })
  @ApiParam({ name: 'productId', type: Number, example: 1 })
  @ApiParam({ name: 'categorySlug', type: String, example: 'menswear' })
  @ApiOkResponse({
    description: 'The product with its FULL current category membership after removal',
    type: ProductCategoriesView,
  })
  @ApiProduces('application/json')
  public async detachProductCategory(
    @Param('productId', ParseIntPipe) productId: number,
    @Param('categorySlug') categorySlug: string,
    @CorrelationId() correlationId: string,
  ): Promise<ProductCategoriesView> {
    return this.detachProductCategoryUseCase.execute({ productId, categorySlug }, correlationId);
  }
}
