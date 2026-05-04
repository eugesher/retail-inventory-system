import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProductStock } from '../../entities';
import {
  ProductStockCommonAddService,
  ProductStockCommonCacheService,
  ProductStockCommonGetService,
} from './providers';
import { ProductStockCommonService } from './product-stock-common.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProductStock])],
  providers: [
    ProductStockCommonService,
    ProductStockCommonAddService,
    ProductStockCommonCacheService,
    ProductStockCommonGetService,
  ],
  exports: [ProductStockCommonService],
})
export class ProductStockCommonModule {}
