import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IProductStockGet,
  MicroserviceMessagePatternEnum,
  ProductStockDto,
} from '@retail-inventory/common';
import { ProductStockGetService } from './services';

@Controller()
export class ProductStockController {
  constructor(private readonly stockGetService: ProductStockGetService) {}

  @MessagePattern(MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET)
  public async getProductStock(@Payload() data: IProductStockGet): Promise<ProductStockDto> {
    return this.stockGetService.execute(data);
  }
}
