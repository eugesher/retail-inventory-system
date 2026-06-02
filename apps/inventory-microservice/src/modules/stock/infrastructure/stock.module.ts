import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';
import { MicroserviceClientNotificationModule } from '@retail-inventory-system/messaging';

import {
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../application/ports';
import {
  AddStockUseCase,
  GetStockUseCase,
  ReserveStockForOrderUseCase,
} from '../application/use-cases';
import { StockController } from '../presentation/stock.controller';
import { StockCache } from './cache';
import { StockRabbitmqPublisher } from './messaging';
import {
  ProductStock,
  ProductStockAction,
  Storage,
  StockTypeormRepository,
  TypeormTransactionAdapter,
} from './persistence';

// `useExisting` shares the single adapter instance with code that injects
// the concrete class directly (e.g. integration tests that assert on
// adapter state).
@Module({
  imports: [
    DatabaseModule.forFeature([ProductStock, ProductStockAction, Storage]),
    MicroserviceClientNotificationModule,
  ],
  controllers: [StockController],
  providers: [
    StockTypeormRepository,
    { provide: STOCK_REPOSITORY, useExisting: StockTypeormRepository },

    StockCache,
    { provide: STOCK_CACHE, useExisting: StockCache },

    StockRabbitmqPublisher,
    { provide: STOCK_EVENTS_PUBLISHER, useExisting: StockRabbitmqPublisher },

    TypeormTransactionAdapter,
    { provide: TRANSACTION_PORT, useExisting: TypeormTransactionAdapter },

    AddStockUseCase,
    GetStockUseCase,
    ReserveStockForOrderUseCase,
  ],
})
export class StockModule {}
