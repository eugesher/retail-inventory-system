import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';
import { MicroserviceClientNotificationModule } from '@retail-inventory-system/messaging';

import { STOCK_CACHE, STOCK_EVENTS_PUBLISHER, STOCK_REPOSITORY } from '../application/ports';
import {
  AddStockUseCase,
  GetStockUseCase,
  ReserveStockForOrderUseCase,
} from '../application/use-cases';
import { StockController } from '../presentation/stock.controller';
import { StockRedisCache } from './cache';
import { StockRabbitmqPublisher } from './messaging';
import {
  Product,
  ProductStock,
  ProductStockAction,
  Storage,
  StockTypeormRepository,
} from './persistence';

// Per-module wiring for the stock bounded context. Binds the three port
// symbols to their concrete adapters; `useExisting` shares the single
// adapter instance with code that injects the concrete class directly
// (e.g. integration tests that need to assert on adapter state).
@Module({
  imports: [
    DatabaseModule.forFeature([Product, ProductStock, ProductStockAction, Storage]),
    MicroserviceClientNotificationModule,
  ],
  controllers: [StockController],
  providers: [
    StockTypeormRepository,
    { provide: STOCK_REPOSITORY, useExisting: StockTypeormRepository },

    StockRedisCache,
    { provide: STOCK_CACHE, useExisting: StockRedisCache },

    StockRabbitmqPublisher,
    { provide: STOCK_EVENTS_PUBLISHER, useExisting: StockRabbitmqPublisher },

    AddStockUseCase,
    GetStockUseCase,
    ReserveStockForOrderUseCase,
  ],
})
export class StockModule {}
