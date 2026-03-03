import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

import {
  MicroserviceEventPatternEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/microservices';
import { IProductStockGet, ProductStockDto } from '@retail-inventory-system/inventory';
import { IOrderCreatedEventPayload } from '@retail-inventory-system/retail';
import { ProductStockGetService, ProductStockHandleOrderCreateService } from './providers';

@Controller()
export class ProductStockController {
  constructor(
    private readonly stockGetService: ProductStockGetService,
    private readonly stockReserveService: ProductStockHandleOrderCreateService,
  ) {}

  @MessagePattern(MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET)
  public async getProductStock(@Payload() data: IProductStockGet): Promise<ProductStockDto> {
    return this.stockGetService.execute(data);
  }

  @EventPattern(MicroserviceEventPatternEnum.RETAIL_ORDER_CREATED)
  public async handleOrderCreated(@Payload() event: IOrderCreatedEventPayload): Promise<void> {
    await this.stockReserveService.execute(event);
  }
}
