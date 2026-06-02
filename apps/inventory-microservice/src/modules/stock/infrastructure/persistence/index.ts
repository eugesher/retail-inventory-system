import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { ProductStock } from './product-stock.entity';
import { ProductStockAction } from './product-stock-action.entity';
import { Storage } from './storage.entity';

export const stockEntities: TypeOrmModuleOptions['entities'] = [
  ProductStock,
  ProductStockAction,
  Storage,
];

export { ProductStock, ProductStockAction, Storage };
export * from './stock-item.mapper';
export * from './stock-typeorm.repository';
export * from './typeorm-transaction.adapter';
