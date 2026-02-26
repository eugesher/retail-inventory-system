import { Module } from '@nestjs/common';

import { MicroserviceClientInventoryModule } from '../../common/modules';
import { ProductStockGetService } from './services';
import { ProductController } from './product.controller';

@Module({
  imports: [MicroserviceClientInventoryModule],
  controllers: [ProductController],
  providers: [ProductStockGetService],
})
export class ProductModule {}
