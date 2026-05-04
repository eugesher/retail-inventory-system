import { Module } from '@nestjs/common';

import { ProductStockCommonModule } from '../../common/modules';
import { ProductStockGetService, ProductStockOrderConfirmService } from './providers';
import { ProductStockController } from './product-stock.controller';

@Module({
  imports: [ProductStockCommonModule],
  providers: [ProductStockGetService, ProductStockOrderConfirmService],
  controllers: [ProductStockController],
})
export class ProductStockModule {}
