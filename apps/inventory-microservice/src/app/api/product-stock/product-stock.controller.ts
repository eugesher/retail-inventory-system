import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

import {
  MicroserviceEventPatternEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { IProductStockGet, ProductStockDto } from '@retail-inventory-system/inventory';
import { IOrderConfirmedEventPayload } from '@retail-inventory-system/retail';
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

  @EventPattern(MicroserviceEventPatternEnum.RETAIL_ORDER_CREATED)
  public async handleOrderCreated(@Payload() event: IOrderConfirmedEventPayload): Promise<void> {
    await this.productStockOrderConfirmService.execute(event);
  }
}
