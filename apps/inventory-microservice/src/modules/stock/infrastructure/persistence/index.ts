import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { StockLevelEntity } from './stock-level.entity';
import { StockLocationEntity } from './stock-location.entity';

export const stockEntities: TypeOrmModuleOptions['entities'] = [
  StockLocationEntity,
  StockLevelEntity,
];

export { StockLocationEntity, StockLevelEntity };
export * from './stock-location.mapper';
export * from './stock-level.mapper';
export * from './stock-typeorm.repository';
export * from './typeorm-transaction.adapter';
