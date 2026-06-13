import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { ReservationEntity } from './reservation.entity';
import { StockLevelEntity } from './stock-level.entity';
import { StockLocationEntity } from './stock-location.entity';

export const stockEntities: TypeOrmModuleOptions['entities'] = [
  StockLocationEntity,
  StockLevelEntity,
  ReservationEntity,
];

export { StockLocationEntity, StockLevelEntity, ReservationEntity };
export * from './stock-location.mapper';
export * from './stock-level.mapper';
export * from './reservation.mapper';
export * from './stock-typeorm.repository';
export * from './reservation-typeorm.repository';
export * from './typeorm-transaction.adapter';
