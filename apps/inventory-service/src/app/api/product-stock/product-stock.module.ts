import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProductStock } from '@retail-inventory/common';
import { ProductStockController } from './product-stock.controller';
import { ProductStockService } from './product-stock.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProductStock])],
  providers: [ProductStockService],
  controllers: [ProductStockController],
})
export class ProductStockModule {}
