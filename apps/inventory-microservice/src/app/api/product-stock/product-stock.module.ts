import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProductStock } from '../../common/entities';
import { ProductStockGetService, ProductStockHandleOrderCreateService } from './providers';
import { ProductStockController } from './product-stock.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ProductStock])],
  providers: [ProductStockGetService, ProductStockHandleOrderCreateService, Logger],
  controllers: [ProductStockController],
})
export class ProductStockModule {}
