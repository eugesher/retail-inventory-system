import { Controller, Get, Param, Query, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom } from 'rxjs';

import {
  IProductStockGet,
  MicroserviceClientNameEnum,
  MicroserviceMessagePatternEnum,
  ProductStockDto,
} from '@retail-inventory/common';

@ApiTags('Product')
@Controller('products')
export class ProductController {
  constructor(
    @Inject(MicroserviceClientNameEnum.INVENTORY_SERVICE) private inventoryClient: ClientProxy,
  ) {}

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
    const data: IProductStockGet = { productId };

    if (storeIds) {
      data.storeIds = storeIds.split(',').map((s) => s.trim());
    }

    return await firstValueFrom(
      this.inventoryClient.send<ProductStockDto, IProductStockGet>(
        MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET,
        data,
      ),
    );
  }
}
