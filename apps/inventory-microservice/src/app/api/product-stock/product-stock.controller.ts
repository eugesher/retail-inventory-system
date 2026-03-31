import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { MicroserviceMessagePatternEnum } from '@retail-inventory-system/common';
import {
  IProductStockGetPayload,
  IProductStockOrderConfirmPayload,
  ProductStockGetResponseDto,
} from '@retail-inventory-system/inventory';
import { ProductStockGetService, ProductStockOrderConfirmService } from './providers';

@Controller()
export class ProductStockController {
  constructor(
    private readonly productStockGetService: ProductStockGetService,
    private readonly productStockOrderConfirmService: ProductStockOrderConfirmService,
  ) {}

  @MessagePattern(MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET)
  public async getProductStock(
    @Payload() payload: IProductStockGetPayload,
  ): Promise<ProductStockGetResponseDto> {
    return this.productStockGetService.execute(payload);
  }

  @MessagePattern(MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM)
  public async handleOrderConfirm(
    @Payload() payload: IProductStockOrderConfirmPayload,
  ): Promise<number[]> {
    return this.productStockOrderConfirmService.execute(payload);
  }
}
