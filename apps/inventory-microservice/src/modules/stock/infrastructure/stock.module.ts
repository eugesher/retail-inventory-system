import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientInventoryModule,
  MicroserviceClientNotificationModule,
} from '@retail-inventory-system/messaging';

import {
  RESERVATION_REPOSITORY,
  RESERVATION_TTL_MINUTES,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../application/ports';
import {
  AdjustStockUseCase,
  AllocateStockUseCase,
  AutoInitStockLevelUseCase,
  CancelAllocationUseCase,
  ListLocationsUseCase,
  QueryAvailabilityUseCase,
  ReceiveStockUseCase,
  ReleaseReservationUseCase,
  ReserveStockUseCase,
} from '../application/use-cases';
import { InventoryRpcExceptionFilter, StockController } from '../presentation';
import { StockCache } from './cache';
import { CatalogEventsConsumer } from './consumers';
import { StockRabbitmqPublisher } from './messaging';
import {
  ReservationEntity,
  ReservationTypeormRepository,
  StockLevelEntity,
  StockLocationEntity,
  StockMovementEntity,
  StockMovementTypeormRepository,
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
    DatabaseModule.forFeature([
      StockLocationEntity,
      StockLevelEntity,
      ReservationEntity,
      StockMovementEntity,
    ]),
    MicroserviceClientNotificationModule,
    MicroserviceClientInventoryModule,
  ],
  controllers: [StockController, CatalogEventsConsumer],
  providers: [
    StockTypeormRepository,
    { provide: STOCK_REPOSITORY, useExisting: StockTypeormRepository },

    // The reservation aggregate's repository (ADR-030), consumed by the Reserve /
    // Release / Allocate use cases below (Cancel-Allocation touches no holds).
    ReservationTypeormRepository,
    { provide: RESERVATION_REPOSITORY, useExisting: ReservationTypeormRepository },

    // The append-only stock-movement audit ledger's repository (ADR-030 §2).
    // Written by Release (`release` rows), Allocate (`allocation` rows), and
    // Cancel-Allocation (`release` rows); the remaining writers (Receive / Adjust /
    // Transfer) and the audit read RPC land in later sessions.
    StockMovementTypeormRepository,
    { provide: STOCK_MOVEMENT_REPOSITORY, useExisting: StockMovementTypeormRepository },

    // The reservation hold lifetime (minutes), resolved from `RESERVATION_TTL_MINUTES`
    // (Joi default 15) so the Reserve use case injects a plain number rather than
    // reading env (the catalog `CATALOG_DEFAULT_CURRENCY` precedent; ADR-030 §4).
    {
      provide: RESERVATION_TTL_MINUTES,
      useFactory: (config: ConfigService): number =>
        config.get<number>('RESERVATION_TTL_MINUTES') ?? 15,
      inject: [ConfigService],
    },

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
    ReserveStockUseCase,
    ReleaseReservationUseCase,
    AllocateStockUseCase,
    CancelAllocationUseCase,

    // Terminates `InventoryDomainException` into the `{ statusCode, message, code }`
    // wire shape the gateway maps (ADR-027). Registered via APP_FILTER so it
    // applies to every `@MessagePattern` handler (the Receive/Adjust write path).
    { provide: APP_FILTER, useClass: InventoryRpcExceptionFilter },
  ],
})
export class StockModule {}
