import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { MicroserviceMessagePatternEnum } from '@retail-inventory-system/common';
import { IProductStockGet, ProductStockDto } from '@retail-inventory-system/inventory';
import { ProductStockGetService, ProductStockOrderConfirmService } from './providers';

@Controller()
export class ProductStockController {
  constructor(
    private readonly productStockGetService: ProductStockGetService,
    private readonly productStockOrderConfirmService: ProductStockOrderConfirmService,
  ) {}

  @MessagePattern(MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET)
  public async getProductStock(@Payload() data: IProductStockGet): Promise<ProductStockDto> {
    return this.productStockGetService.execute(data);
  }

  @MessagePattern(MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM)
  public async handleOrderConfirmed(@Payload() data: unknown): Promise<void> {
    await this.productStockOrderConfirmService.execute(data);
  }
}
