import { Controller, Get, Param, Query, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  ProductStockGetDto,
  MicroserviceClientNameEnum,
  MicroserviceMessagePatternEnum,
  ProductStockResponseDto,
} from '@retail-inventory/common';

@Controller('products')
export class ProductController {
  constructor(
    @Inject(MicroserviceClientNameEnum.INVENTORY_SERVICE) private inventoryClient: ClientProxy,
  ) {}

  @Get(':productId/stock')
  public async getProductStock(
    @Param('productId') productId: string,
    @Query('storeIds') storeIds?: string,
  ): Promise<ProductStockResponseDto> {
    const dto: ProductStockGetDto = { productId };

    if (storeIds) {
      dto.storeIds = storeIds.split(',').map((s) => s.trim());
    }

    return await firstValueFrom(
      this.inventoryClient.send<ProductStockResponseDto, ProductStockGetDto>(
        MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET,
        dto,
      ),
    );
  }
}
