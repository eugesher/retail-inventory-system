import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';
import { MicroserviceClientNotificationModule } from '@retail-inventory-system/messaging';

import {
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../application/ports';
import { ListLocationsUseCase, QueryAvailabilityUseCase } from '../application/use-cases';
import { StockController } from '../presentation/stock.controller';
import { StockCache } from './cache';
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
// the new `v2`/`variantId` key shape). The events publisher and transaction
// adapter are retained for the write operations later inventory capabilities add;
// the `inventory.order.confirm` deprecation stub stays on the controller.
@Module({
  imports: [
    DatabaseModule.forFeature([StockLocationEntity, StockLevelEntity]),
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

    QueryAvailabilityUseCase,
    ListLocationsUseCase,
  ],
})
export class StockModule {}
