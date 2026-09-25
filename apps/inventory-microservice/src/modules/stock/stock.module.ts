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

    ReservationTypeormRepository,
    { provide: RESERVATION_REPOSITORY, useExisting: ReservationTypeormRepository },

    StockMovementTypeormRepository,
    { provide: STOCK_MOVEMENT_REPOSITORY, useExisting: StockMovementTypeormRepository },

    {
      provide: RESERVATION_TTL_MINUTES,
      useFactory: (config: ConfigService): number =>
        config.get<number>('RESERVATION_TTL_MINUTES') ?? 15,
      inject: [ConfigService],
    },

    {
      provide: OCC_RETRY_ATTEMPTS,
      useFactory: (config: ConfigService): number => config.get<number>('OCC_RETRY_ATTEMPTS') ?? 5,
      inject: [ConfigService],
    },

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

    ReservationSweepScheduler,

    { provide: APP_FILTER, useClass: InventoryRpcExceptionFilter },
  ],
})
export class StockModule {}
