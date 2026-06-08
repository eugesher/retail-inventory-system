import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';
import { MicroserviceClientNotificationModule } from '@retail-inventory-system/messaging';

import { STOCK_EVENTS_PUBLISHER, STOCK_REPOSITORY, TRANSACTION_PORT } from '../application/ports';
import { StockController } from '../presentation/stock.controller';
import { StockRabbitmqPublisher } from './messaging';
import {
  StockLevelEntity,
  StockLocationEntity,
  StockTypeormRepository,
  TypeormTransactionAdapter,
} from './persistence';

// `useExisting` shares the single adapter instance with code that injects the
// concrete class directly. The repository, the events publisher, and the
// transaction adapter are retained for the read/write operations the later
// inventory capabilities add; this foundation wires only the persistence
// surface and the `inventory.order.confirm` deprecation stub (no use cases,
// no cache — the `StockCache` rebuild lands with the availability read path).
@Module({
  imports: [
    DatabaseModule.forFeature([StockLocationEntity, StockLevelEntity]),
    MicroserviceClientNotificationModule,
  ],
  controllers: [StockController],
  providers: [
    StockTypeormRepository,
    { provide: STOCK_REPOSITORY, useExisting: StockTypeormRepository },

    StockRabbitmqPublisher,
    { provide: STOCK_EVENTS_PUBLISHER, useExisting: StockRabbitmqPublisher },

    TypeormTransactionAdapter,
    { provide: TRANSACTION_PORT, useExisting: TypeormTransactionAdapter },
  ],
})
export class StockModule {}
