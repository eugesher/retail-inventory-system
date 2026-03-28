import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { MicroserviceMessagePatternEnum } from '@retail-inventory-system/common';
import {
  IProductStockGetPayload,
  IProductStockOrderConfirmPayload,
  ProductStockDto,
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
  ): Promise<ProductStockDto> {
    const { correlationId, ...data } = payload;

    Logger.log(
      { message: 'Retrieving the remaining product stock on the inventory side', data },
      correlationId,
    ); // TODO: RIS-20 Replace with pino

    return this.productStockGetService.execute(payload);
  }

  @MessagePattern(MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM)
  public async handleOrderConfirm(
    @Payload() payload: IProductStockOrderConfirmPayload,
  ): Promise<number[]> {
    const { correlationId, ...data } = payload;

    Logger.log(
      { message: 'Order confirmation processing has begun on the inventory side', data },
      correlationId,
    ); // TODO: RIS-20 Replace with pino

    return this.productStockOrderConfirmService.execute(payload);
  }
}
