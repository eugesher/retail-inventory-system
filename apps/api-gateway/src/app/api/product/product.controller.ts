import { Controller, Get, Param, Query } from '@nestjs/common';
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
      'Returns available quantity per store. If no storeIds provided → returns all stores.',
  })
  @ApiParam({
    name: 'productId',
    description: 'Unique product identifier (e.g. prod-001)',
    example: 'prod-001',
  })
  @ApiQuery({
    name: 'storeIds',
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
    @Param('productId') productId: string,
    @Query('storeIds') storeIds?: string,
  ): Promise<ProductStockDto> {
    return await this.stockGetService.execute(productId, storeIds);
  }
}
