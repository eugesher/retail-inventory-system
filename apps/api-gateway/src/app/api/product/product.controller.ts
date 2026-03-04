import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { ProductStockDto } from '@retail-inventory-system/inventory';
import { ProductStockGetService } from './providers';

@ApiTags('Product')
@Controller('product')
export class ProductController {
  constructor(private readonly stockGetService: ProductStockGetService) {}

  @ApiOperation({
    summary: 'Get current stock levels for a product',
    description:
      'Returns available quantity per store. If no storageIds provided → returns all stores.',
  })
  @ApiParam({
    name: 'productId',
    description: 'Unique product identifier (e.g. prod-001)',
    example: 'prod-001',
  })
  @ApiQuery({
    name: 'storageIds',
    required: false,
    description: 'Comma-separated list of store IDs (optional)',
    example: 'store-001,store-002',
  })
  @ApiOkResponse({
    description: 'Stock information successfully retrieved',
    type: ProductStockDto,
  })
  @ApiProduces('application/json')
  @Get(':productId/stock')
  public async getProductStock(
    @Param('productId', ParseIntPipe) productId: number,
    @Query('storageIds') storageIds?: string,
  ): Promise<ProductStockDto> {
    return await this.stockGetService.execute(productId, storageIds);
  }
}
