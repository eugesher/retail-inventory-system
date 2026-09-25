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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';

import { Public, RequiresPermission } from '@retail-inventory-system/auth';
import {
  MediaAssetView,
  MediaOwnerTypeEnum,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  AttachMediaUseCase,
  DetachMediaUseCase,
  ListMediaUseCase,
  ReorderMediaUseCase,
} from '../application/use-cases';
import { AttachMediaRequestDto, ReorderMediaRequestDto } from './dto';

@ApiTags('Catalog')
@Controller('catalog')
export class MediaController {
  constructor(
    private readonly attachMediaUseCase: AttachMediaUseCase,
    private readonly reorderMediaUseCase: ReorderMediaUseCase,
    private readonly detachMediaUseCase: DetachMediaUseCase,
    private readonly listMediaUseCase: ListMediaUseCase,
  ) {}

  @Post('media')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Attach a media asset to a product or variant (appends to the strip)' })
  @ApiCreatedResponse({ description: 'Media asset attached', type: MediaAssetView })
  @ApiProduces('application/json')
  public async attachMedia(
    @Body() dto: AttachMediaRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<MediaAssetView> {
    return this.attachMediaUseCase.execute(dto, correlationId);
  }

  @Patch('media/reorder')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder an owner media strip (exact active-set permutation)' })
  @ApiOkResponse({
    description: 'The refreshed active media strip in its new order',
    type: MediaAssetView,
    isArray: true,
  })
  @ApiProduces('application/json')
  public async reorderMedia(
    @Body() dto: ReorderMediaRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<MediaAssetView[]> {
    return this.reorderMediaUseCase.execute(dto, correlationId);
  }

  @Delete('media/:id')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Detach a media asset (status flip active → archived, the row survives)',
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The archived media asset', type: MediaAssetView })
  @ApiProduces('application/json')
  public async detachMedia(
    @Param('id', ParseIntPipe) id: number,
    @CorrelationId() correlationId: string,
  ): Promise<MediaAssetView> {
    return this.detachMediaUseCase.execute(id, correlationId);
  }

  @Get('products/:productId/media')
  @Public()
  @ApiOperation({ summary: 'List a product active media (sorted)' })
  @ApiParam({ name: 'productId', type: Number, example: 1 })
  @ApiOkResponse({
    description: 'Active media for the product',
    type: MediaAssetView,
    isArray: true,
  })
  @ApiProduces('application/json')
  public async listProductMedia(
    @Param('productId', ParseIntPipe) productId: number,
    @CorrelationId() correlationId: string,
  ): Promise<MediaAssetView[]> {
    return this.listMediaUseCase.execute(
      { ownerType: MediaOwnerTypeEnum.PRODUCT, ownerId: productId },
      correlationId,
    );
  }

  @Get('variants/:variantId/media')
  @Public()
  @ApiOperation({ summary: 'List a variant active media (sorted)' })
  @ApiParam({ name: 'variantId', type: Number, example: 1 })
  @ApiOkResponse({
    description: 'Active media for the variant',
    type: MediaAssetView,
    isArray: true,
  })
  @ApiProduces('application/json')
  public async listVariantMedia(
    @Param('variantId', ParseIntPipe) variantId: number,
    @CorrelationId() correlationId: string,
  ): Promise<MediaAssetView[]> {
    return this.listMediaUseCase.execute(
      { ownerType: MediaOwnerTypeEnum.PRODUCT_VARIANT, ownerId: variantId },
      correlationId,
    );
  }
}
