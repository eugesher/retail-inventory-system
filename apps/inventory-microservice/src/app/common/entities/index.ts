import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { Product } from './product.entity';
import { ProductStock } from './product-stock.entity';
import { ProductStockAction } from './product-stock-action.entity';
import { Storage } from './storage.entity';

export const entities: TypeOrmModuleOptions['entities'] = [
  Product,
  ProductStock,
  ProductStockAction,
  Storage,
];

export { Product, ProductStock, ProductStockAction, Storage };
