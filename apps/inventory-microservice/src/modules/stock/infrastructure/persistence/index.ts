import { ReservationEntity } from './reservation.entity';
import { StockLevelEntity } from './stock-level.entity';
import { StockLocationEntity } from './stock-location.entity';
import { StockMovementEntity } from './stock-movement.entity';

// The module's entity list: `DatabaseModule.forRoot(...)` in `app.module.ts`, and
// `forFeature(...)` in the module file. UNANNOTATED on purpose — see the note on
// `DatabaseModule.forRoot` for why the parameter type must not be used here.
export const stockEntities = [
  StockLocationEntity,
  StockLevelEntity,
  ReservationEntity,
  StockMovementEntity,
];

export { StockLocationEntity, StockLevelEntity, ReservationEntity, StockMovementEntity };
export * from './stock-location.mapper';
export * from './stock-level.mapper';
export * from './reservation.mapper';
export * from './stock-movement.mapper';
export * from './stock-typeorm.repository';
export * from './reservation-typeorm.repository';
export * from './stock-movement-typeorm.repository';
export * from './typeorm-transaction.adapter';
