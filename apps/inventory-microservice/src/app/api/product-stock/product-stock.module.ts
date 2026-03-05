import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProductStock } from '../../common/entities';
import { ProductStockGetService, ProductStockOrderConfirmedHandleService } from './providers';
import { ProductStockController } from './product-stock.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ProductStock])],
  providers: [ProductStockGetService, ProductStockOrderConfirmedHandleService, Logger],
  controllers: [ProductStockController],
})
export class ProductStockModule {}
