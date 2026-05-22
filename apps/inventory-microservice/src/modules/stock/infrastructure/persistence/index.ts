import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { Product } from './product.entity';
import { ProductStock } from './product-stock.entity';
import { ProductStockAction } from './product-stock-action.entity';
import { Storage } from './storage.entity';

export const stockEntities: TypeOrmModuleOptions['entities'] = [
  Product,
  ProductStock,
  ProductStockAction,
  Storage,
];

export { Product, ProductStock, ProductStockAction, Storage };
export * from './stock-item.mapper';
export * from './stock-typeorm.repository';
export * from './typeorm-transaction.adapter';
