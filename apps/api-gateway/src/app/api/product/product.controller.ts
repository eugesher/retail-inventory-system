import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';

import { CorrelationId } from '@retail-inventory-system/common';
import { ProductStockDto } from '@retail-inventory-system/inventory';
import { ProductStockGetDto } from './dto';
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
  @ApiOkResponse({
    description: 'Stock information successfully retrieved',
    type: ProductStockDto,
  })
  @ApiProduces('application/json')
  @Get(':productId/stock')
  public async getProductStock(
    @Param('productId', ParseIntPipe) productId: number,
    @Query() dto: ProductStockGetDto,
    @CorrelationId() correlationId: string,
  ): Promise<ProductStockDto> {
    return await this.stockGetService.execute(productId, dto, correlationId);
  }
}
