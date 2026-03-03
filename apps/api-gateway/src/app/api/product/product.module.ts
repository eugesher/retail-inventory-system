import { Module } from '@nestjs/common';

import { InventoryMicroserviceClientModule } from '@retail-inventory-system/microservices';
import { ProductStockGetService } from './providers';
import { ProductController } from './product.controller';

@Module({
  imports: [InventoryMicroserviceClientModule],
  controllers: [ProductController],
  providers: [ProductStockGetService],
})
export class ProductModule {}
