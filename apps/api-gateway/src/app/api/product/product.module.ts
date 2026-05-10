import { Module } from '@nestjs/common';

import { MicroserviceClientInventoryModule } from '@retail-inventory-system/messaging';
import { ProductStockGetService } from './providers';
import { ProductController } from './product.controller';

@Module({
  imports: [MicroserviceClientInventoryModule],
  controllers: [ProductController],
  providers: [ProductStockGetService],
})
export class ProductModule {}
