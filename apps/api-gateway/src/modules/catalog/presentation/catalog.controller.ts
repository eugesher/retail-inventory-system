import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
  IPage,
  PermissionCodeEnum,
  ProductVariantView,
  ProductView,
  ProductWithVariantsView,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  AddVariantUseCase,
  ArchiveProductUseCase,
  GetProductUseCase,
  GetVariantUseCase,
  ListProductsUseCase,
  PublishProductUseCase,
  RegisterProductUseCase,
} from '../application/use-cases';
import { CreateVariantRequestDto, ListProductsQueryDto, RegisterProductRequestDto } from './dto';

// HTTP surface over the catalog microservice's seven RPCs (ADR-009). Write
// routes are permission-gated per ADR-024 — `catalog:write` for the
// register/add-variant/archive mutations and `catalog:publish` for the publish
// transition; customer tokens carry no `permissions` claim, so the write routes
// are staff-only by construction. Read routes are `@Public()` so an
// unauthenticated shopper can browse the catalogue.
@ApiTags('Catalog')
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly registerProductUseCase: RegisterProductUseCase,
    private readonly addVariantUseCase: AddVariantUseCase,
    private readonly publishProductUseCase: PublishProductUseCase,
    private readonly archiveProductUseCase: ArchiveProductUseCase,
    private readonly listProductsUseCase: ListProductsUseCase,
    private readonly getProductUseCase: GetProductUseCase,
    private readonly getVariantUseCase: GetVariantUseCase,
  ) {}

  @Post('products')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register a new draft product' })
  @ApiCreatedResponse({ description: 'Draft product created', type: ProductView })
  @ApiProduces('application/json')
  public async registerProduct(
    @Body() dto: RegisterProductRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<ProductView> {
    return this.registerProductUseCase.execute(dto, correlationId);
  }

  @Post('products/:productId/variants')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Append a variant to a product' })
  @ApiParam({ name: 'productId', type: Number, example: 1 })
  @ApiCreatedResponse({ description: 'Variant appended', type: ProductVariantView })
  @ApiProduces('application/json')
  public async addVariant(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() dto: CreateVariantRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<ProductVariantView> {
    return this.addVariantUseCase.execute({ ...dto, productId }, correlationId);
  }

  @Post('products/:productId/publish')
  @RequiresPermission(PermissionCodeEnum.CATALOG_PUBLISH)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a product (draft → active)' })
  @ApiParam({ name: 'productId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'Product activated', type: ProductView })
  @ApiProduces('application/json')
  public async publishProduct(
    @Param('productId', ParseIntPipe) productId: number,
    @CorrelationId() correlationId: string,
  ): Promise<ProductView> {
    return this.publishProductUseCase.execute(productId, correlationId);
  }

  @Post('products/:productId/archive')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a product (active → archived, terminal)' })
  @ApiParam({ name: 'productId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'Product archived', type: ProductView })
  @ApiProduces('application/json')
  public async archiveProduct(
    @Param('productId', ParseIntPipe) productId: number,
    @CorrelationId() correlationId: string,
  ): Promise<ProductView> {
    return this.archiveProductUseCase.execute(productId, correlationId);
  }

  @Get('products')
  @Public()
  @ApiOperation({ summary: 'Browse the active catalogue (paginated)' })
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
  public async listProducts(
    @Query() query: ListProductsQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<IPage<ProductWithVariantsView>> {
    return this.listProductsUseCase.execute(query, correlationId);
  }

  @Get('products/:slug')
  @Public()
  @ApiOperation({ summary: 'Fetch a product by slug with its active variants' })
  @ApiParam({ name: 'slug', type: String, example: 'aeron-chair' })
  @ApiOkResponse({ description: 'Product with active variants', type: ProductWithVariantsView })
  @ApiProduces('application/json')
  public async getProduct(
    @Param('slug') slug: string,
    @CorrelationId() correlationId: string,
  ): Promise<ProductWithVariantsView> {
    return this.getProductUseCase.execute(slug, correlationId);
  }

  @Get('variants/:variantId')
  @Public()
  @ApiOperation({ summary: 'Fetch a variant by id with its parent product header' })
  @ApiParam({ name: 'variantId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'Variant with parent product', type: VariantWithProductView })
  @ApiProduces('application/json')
  public async getVariant(
    @Param('variantId', ParseIntPipe) variantId: number,
    @CorrelationId() correlationId: string,
  ): Promise<VariantWithProductView> {
    return this.getVariantUseCase.execute(variantId, correlationId);
  }
}
