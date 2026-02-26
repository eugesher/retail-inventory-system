import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProductStock } from '../../common/entities';
import { ProductStockGetService } from './services';
import { ProductStockController } from './product-stock.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ProductStock])],
  providers: [ProductStockGetService],
  controllers: [ProductStockController],
})
export class ProductStockModule {}
