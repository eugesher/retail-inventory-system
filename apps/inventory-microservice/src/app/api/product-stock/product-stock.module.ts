import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProductStock } from '../../common/entities';
import { ProductStockGetService, ProductStockOrderConfirmService } from './providers';
import { ProductStockController } from './product-stock.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ProductStock])],
  providers: [ProductStockGetService, ProductStockOrderConfirmService],
  controllers: [ProductStockController],
})
export class ProductStockModule {}
