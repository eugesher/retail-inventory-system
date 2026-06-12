import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientInventoryModule,
  MicroserviceClientNotificationModule,
} from '@retail-inventory-system/messaging';

import {
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../application/ports';
import {
  AdjustStockUseCase,
  AutoInitStockLevelUseCase,
  ListLocationsUseCase,
  QueryAvailabilityUseCase,
  ReceiveStockUseCase,
} from '../application/use-cases';
import { InventoryRpcExceptionFilter, StockController } from '../presentation';
import { StockCache } from './cache';
import { CatalogEventsConsumer } from './consumers';
import { StockRabbitmqPublisher } from './messaging';
import {
  StockLevelEntity,
  StockLocationEntity,
  StockTypeormRepository,
  TypeormTransactionAdapter,
} from './persistence';

// `useExisting` shares the single adapter instance with code that injects the
// concrete class directly. The read path (Query Availability + List Locations)
// is wired here together with the rebuilt `StockCache` (the cache-aside seam on
// the new `v2`/`variantId` key shape). The `CatalogEventsConsumer` subscribes to
// `catalog.variant.created` (auto-init), driving `AutoInitStockLevelUseCase`.
//
// Two messaging clients are imported: `MicroserviceClientNotificationModule` for
// `inventory.stock.low`, and `MicroserviceClientInventoryModule` so the publisher
// can emit `inventory.stock-level.initialized` onto this service's own queue. The
// transaction adapter backs the Receive/Adjust write path and the optimistic
// writes the inventory-reservation capability adds.
@Module({
  imports: [
    DatabaseModule.forFeature([StockLocationEntity, StockLevelEntity]),
    MicroserviceClientNotificationModule,
    MicroserviceClientInventoryModule,
  ],
  controllers: [StockController, CatalogEventsConsumer],
  providers: [
    StockTypeormRepository,
    { provide: STOCK_REPOSITORY, useExisting: StockTypeormRepository },

    StockCache,
    { provide: STOCK_CACHE, useExisting: StockCache },

    StockRabbitmqPublisher,
    { provide: STOCK_EVENTS_PUBLISHER, useExisting: StockRabbitmqPublisher },

    TypeormTransactionAdapter,
    { provide: TRANSACTION_PORT, useExisting: TypeormTransactionAdapter },

    AutoInitStockLevelUseCase,
    QueryAvailabilityUseCase,
    ListLocationsUseCase,
    ReceiveStockUseCase,
    AdjustStockUseCase,

    // Terminates `InventoryDomainException` into the `{ statusCode, message, code }`
    // wire shape the gateway maps (ADR-027). Registered via APP_FILTER so it
    // applies to every `@MessagePattern` handler (the Receive/Adjust write path).
    { provide: APP_FILTER, useClass: InventoryRpcExceptionFilter },
  ],
})
export class StockModule {}
