import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientInventoryModule,
  MicroserviceClientNotificationModule,
  MicroserviceClientRetailModule,
  MicroserviceClientRisEventsModule,
} from '@retail-inventory-system/messaging';

import {
  INVENTORY_RESTOCK_GATEWAY,
  RETURN_CUSTOMER_CONTACT_READER,
  RETURN_EVENTS_PUBLISHER,
  RETURN_ORDER_READER,
  RETURN_REQUEST_REPOSITORY,
  RETURN_WINDOW_DAYS,
  TRANSACTION_PORT,
} from '../application/ports';
import {
  AuthorizeReturnUseCase,
  CloseReturnUseCase,
  GetReturnUseCase,
  InspectAndDispositionUseCase,
  ListReturnsForOrderUseCase,
  OpenReturnRequestUseCase,
  ReceiveReturnUseCase,
  RejectReturnUseCase,
} from '../application/use-cases';
import { InventoryRestockRabbitmqAdapter, ReturnRabbitmqPublisher } from './messaging';
import {
  CustomerContactReaderTypeormAdapter,
  ReturnOrderReaderTypeormAdapter,
  ReturnRequestEntity,
  ReturnLineEntity,
  ReturnRequestTypeormRepository,
  TypeormTransactionAdapter,
} from './persistence';
import { ReturnsController, ReturnRpcExceptionFilter } from '../presentation';

// The returns bounded-context module — now the **live RMA lifecycle** (ADR-032), no longer
// providers-only. It owns the `ReturnRequest` aggregate (root + `ReturnLine` children),
// its repository, the seven lifecycle/read RPCs, their controller, and the two outbound
// seams: the raw-SQL order reader (`RETURN_ORDER_READER`, the cross-module read of the
// `order`/`order_line`/`fulfillment` tables the Open use case needs without importing the
// orders module — ADR-017/028) and the events publisher (`RETURN_EVENTS_PUBLISHER`).
// `useExisting` shares the single adapter instance with code that injects the concrete
// class, while the use cases depend on the port symbols (the `cart.module.ts` /
// `stock.module.ts` pattern).
//
// Three messaging clients are imported: `MicroserviceClientNotificationModule` so the
// publisher can emit the buyer-facing `retail.return.requested`/`.authorized`/`.received`/
// `.inspected` onto `notification_events` (the consumer's own queue),
// `MicroserviceClientRetailModule` so it can emit the internal `retail.return.rejected`/
// `.closed` onto `retail_queue` (the producer-targets-consumer-queue split, ADR-008/020),
// and `MicroserviceClientInventoryModule` so the `INVENTORY_RESTOCK_GATEWAY` adapter can
// call `inventory.stock.restock-from-return` on `inventory_queue` (the Inspect &
// Disposition cross-service restock, ADR-032). A fourth client,
// `MicroserviceClientRisEventsModule`, provides the `ris.events` topic-exchange client
// so the publisher can mirror every return event onto the event-store firehose (ADR-035,
// the `RisEventsMirrorPublisher` dual-publish). `RETURN_WINDOW_DAYS` is a
// `ConfigService`-backed value provider resolving `RETURN_WINDOW_DAYS` (Joi default 30) so
// the Open use case injects a plain number (the inventory `RESERVATION_TTL_MINUTES`
// precedent). `TRANSACTION_PORT` is now wired (the Inspect use case records the per-line
// outcome + walks the status in one unit of work). The `ReturnRpcExceptionFilter` is
// registered via `APP_FILTER` so it maps every handler's `ReturnDomainException` onto the
// wire status the gateway resolves.
@Module({
  imports: [
    DatabaseModule.forFeature([ReturnRequestEntity, ReturnLineEntity]),
    MicroserviceClientNotificationModule,
    MicroserviceClientRetailModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientRisEventsModule,
  ],
  controllers: [ReturnsController],
  providers: [
    ReturnRequestTypeormRepository,
    { provide: RETURN_REQUEST_REPOSITORY, useExisting: ReturnRequestTypeormRepository },

    ReturnOrderReaderTypeormAdapter,
    { provide: RETURN_ORDER_READER, useExisting: ReturnOrderReaderTypeormAdapter },

    // The raw-SQL read of the gateway-owned `customer.email` the return events carry, so the
    // notification consumer has a recipient without a per-delivery RPC (ADR-033). A local copy
    // of the orders reader — returns cannot import the orders module (ADR-017), the
    // `retry-then-log-for-replay` per-module-copy precedent.
    CustomerContactReaderTypeormAdapter,
    { provide: RETURN_CUSTOMER_CONTACT_READER, useExisting: CustomerContactReaderTypeormAdapter },

    TypeormTransactionAdapter,
    { provide: TRANSACTION_PORT, useExisting: TypeormTransactionAdapter },

    ReturnRabbitmqPublisher,
    { provide: RETURN_EVENTS_PUBLISHER, useExisting: ReturnRabbitmqPublisher },

    InventoryRestockRabbitmqAdapter,
    { provide: INVENTORY_RESTOCK_GATEWAY, useExisting: InventoryRestockRabbitmqAdapter },

    // The return-eligibility window (days), resolved from `RETURN_WINDOW_DAYS` (Joi
    // default 30) so the Open use case injects a plain number rather than reading env
    // (the inventory `RESERVATION_TTL_MINUTES` precedent; ADR-032).
    {
      provide: RETURN_WINDOW_DAYS,
      useFactory: (config: ConfigService): number => config.get<number>('RETURN_WINDOW_DAYS') ?? 30,
      inject: [ConfigService],
    },

    OpenReturnRequestUseCase,
    AuthorizeReturnUseCase,
    RejectReturnUseCase,
    ReceiveReturnUseCase,
    InspectAndDispositionUseCase,
    CloseReturnUseCase,
    GetReturnUseCase,
    ListReturnsForOrderUseCase,

    { provide: APP_FILTER, useClass: ReturnRpcExceptionFilter },
  ],
  exports: [RETURN_REQUEST_REPOSITORY],
})
export class ReturnsModule {}
