import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IProductStockGet,
  MicroserviceMessagePatternEnum,
  ProductStockDto,
} from '@retail-inventory/common';
import { ProductStockService } from './product-stock.service';

@Controller()
export class ProductStockController {
  constructor(private readonly productStockService: ProductStockService) {}

  @MessagePattern(MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET)
  public async getProductStock(@Payload() data: IProductStockGet): Promise<ProductStockDto> {
    return this.productStockService.getProductStock(data);
  }
}
