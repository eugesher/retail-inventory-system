import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { DatabaseModule, TypeormTransactionAdapter } from '@retail-inventory-system/database';
import {
  MicroserviceClientInventoryModule,
  MicroserviceClientNotificationModule,
  MicroserviceClientRisEventsModule,
} from '@retail-inventory-system/messaging';

import {
  OCC_RETRY_ATTEMPTS,
  RESERVATION_REPOSITORY,
  RESERVATION_SWEEP_BATCH_SIZE,
  RESERVATION_SWEEP_INTERVAL_SECONDS,
  RESERVATION_SWEEP_TRANSACTION_SIZE,
  RESERVATION_TTL_MINUTES,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from './application/ports';
import {
  AdjustStockUseCase,
  AllocateStockUseCase,
  AutoInitStockLevelUseCase,
  CancelAllocationUseCase,
  CommitSaleUseCase,
  ListLocationsUseCase,
  ListStockMovementsUseCase,
  QueryAvailabilityUseCase,
  ReceiveStockUseCase,
  ReleaseReservationUseCase,
  ReserveStockUseCase,
  RestockFromReturnUseCase,
  SweepExpiredReservationsUseCase,
  TransferStockUseCase,
} from './application/use-cases';
import { InventoryRpcExceptionFilter, StockController } from './presentation';
import { StockCache } from './infrastructure/cache';
import { CatalogEventsConsumer } from './infrastructure/consumers';
import { StockRabbitmqPublisher } from './infrastructure/messaging';
import { ReservationSweepScheduler } from './infrastructure/scheduling';
import {
  ReservationTypeormRepository,
  StockMovementTypeormRepository,
  StockTypeormRepository,
  stockEntities,
} from './infrastructure/persistence';

// `useExisting` shares the single adapter instance with code that injects the
// concrete class directly. The read path (Query Availability + List Locations)
// is wired here together with the rebuilt `StockCache` (the cache-aside seam on
// the new `v2`/`variantId` key shape). The `CatalogEventsConsumer` subscribes to
// `catalog.variant.created` (auto-init), driving `AutoInitStockLevelUseCase`.
//
// Three messaging clients are imported: `MicroserviceClientNotificationModule` for
// `inventory.stock.low`, `MicroserviceClientInventoryModule` so the publisher can
// emit `inventory.stock-level.initialized` onto this service's own queue, and
// `MicroserviceClientRisEventsModule` so the publisher can mirror every stock event
// onto the `ris.events` topic exchange for the event-store firehose (ADR-035, the
// `RisEventsMirrorPublisher` dual-publish). The transaction adapter backs the
// Receive/Adjust write path and the optimistic writes the inventory-reservation
// capability adds.
//
// `ScheduleModule.forRoot()` brings in the `SchedulerRegistry` that `ReservationSweepScheduler`
// registers its timer with (ADR-038). This is the inventory service's only scheduled job.
@Module({
  imports: [
    DatabaseModule.forFeature(stockEntities),
    MicroserviceClientNotificationModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientRisEventsModule,
    ScheduleModule.forRoot(),
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
    // Every counter-changing operation appends here: Receive (`receipt`), Adjust
    // (signed `adjustment`), Reserve/Release/Cancel (`release`), Allocate
    // (`allocation`), and Transfer (a paired `adjustment` per leg). The audit read
    // path (`ListStockMovementsUseCase`) reads it back via `listByVariant`.
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

    // The bounded optimistic-concurrency retry budget, resolved from `OCC_RETRY_ATTEMPTS`
    // (Joi default 5) so every stock write use case injects a plain number rather than
    // reading env (ADR-036; the `RESERVATION_TTL_MINUTES` precedent above). Threaded into
    // `runWithStockWriteRetry` via the per-use-case retry deps.
    {
      provide: OCC_RETRY_ATTEMPTS,
      useFactory: (config: ConfigService): number => config.get<number>('OCC_RETRY_ATTEMPTS') ?? 5,
      inject: [ConfigService],
    },

    // The two bounds the expired-reservation sweep runs under (ADR-038), resolved from
    // `RESERVATION_SWEEP_BATCH_SIZE` (Joi default 200) and
    // `RESERVATION_SWEEP_TRANSACTION_SIZE` (Joi default 25) — the batch size caps the rows
    // one invocation scans and expires, the transaction size the rows one transaction
    // locks. Value providers, so the use case never reads env (the `OCC_RETRY_ATTEMPTS`
    // precedent above; ADR-017).
    {
      provide: RESERVATION_SWEEP_BATCH_SIZE,
      useFactory: (config: ConfigService): number =>
        config.get<number>('RESERVATION_SWEEP_BATCH_SIZE') ?? 200,
      inject: [ConfigService],
    },
    {
      provide: RESERVATION_SWEEP_TRANSACTION_SIZE,
      useFactory: (config: ConfigService): number =>
        config.get<number>('RESERVATION_SWEEP_TRANSACTION_SIZE') ?? 25,
      inject: [ConfigService],
    },

    // The sweep's cadence (seconds, Joi default 60), injected into `ReservationSweepScheduler`
    // rather than baked into a schedule decorator — a decorator argument is evaluated at class
    // definition, before any `ConfigService` exists (ADR-038).
    {
      provide: RESERVATION_SWEEP_INTERVAL_SECONDS,
      useFactory: (config: ConfigService): number =>
        config.get<number>('RESERVATION_SWEEP_INTERVAL_SECONDS') ?? 60,
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
    ListStockMovementsUseCase,
    ReceiveStockUseCase,
    AdjustStockUseCase,
    ReserveStockUseCase,
    ReleaseReservationUseCase,
    SweepExpiredReservationsUseCase,
    AllocateStockUseCase,
    CancelAllocationUseCase,
    CommitSaleUseCase,
    RestockFromReturnUseCase,
    TransferStockUseCase,

    // The timer that drives `SweepExpiredReservationsUseCase` (ADR-038). It registers its
    // interval imperatively in `onModuleInit` and deletes it in `onModuleDestroy`.
    ReservationSweepScheduler,

    // Terminates `InventoryDomainException` into the `{ statusCode, message, code }`
    // wire shape the gateway maps (ADR-027). Registered via APP_FILTER so it
    // applies to every `@MessagePattern` handler (the Receive/Adjust write path).
    { provide: APP_FILTER, useClass: InventoryRpcExceptionFilter },
  ],
})
export class StockModule {}
