import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IProductStockGetPayload,
  IProductStockOrderConfirmPayload,
  ProductStockGetResponseDto,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { GetStockUseCase, ReserveStockForOrderUseCase } from '../application/use-cases';

@Controller()
export class StockController {
  constructor(
    private readonly getStockUseCase: GetStockUseCase,
    private readonly reserveStockForOrderUseCase: ReserveStockForOrderUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.INVENTORY_PRODUCT_STOCK_GET)
  public async getProductStock(
    @Payload() payload: IProductStockGetPayload,
  ): Promise<ProductStockGetResponseDto> {
    return this.getStockUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM)
  public async handleOrderConfirm(
    @Payload() payload: IProductStockOrderConfirmPayload,
  ): Promise<number[]> {
    return this.reserveStockForOrderUseCase.execute(payload);
  }
}
