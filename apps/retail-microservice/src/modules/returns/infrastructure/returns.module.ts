import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientNotificationModule,
  MicroserviceClientRetailModule,
} from '@retail-inventory-system/messaging';

import {
  RETURN_EVENTS_PUBLISHER,
  RETURN_ORDER_READER,
  RETURN_REQUEST_REPOSITORY,
  RETURN_WINDOW_DAYS,
} from '../application/ports';
import {
  AuthorizeReturnUseCase,
  CloseReturnUseCase,
  GetReturnUseCase,
  ListReturnsForOrderUseCase,
  OpenReturnRequestUseCase,
  ReceiveReturnUseCase,
  RejectReturnUseCase,
} from '../application/use-cases';
import { ReturnRabbitmqPublisher } from './messaging';
import {
  ReturnOrderReaderTypeormAdapter,
  ReturnRequestEntity,
  ReturnLineEntity,
  ReturnRequestTypeormRepository,
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
// Two messaging clients are imported: `MicroserviceClientNotificationModule` so the
// publisher can emit the buyer-facing `retail.return.requested`/`.authorized`/`.received`
// onto `notification_events` (the consumer's own queue), and `MicroserviceClientRetailModule`
// so it can emit the internal `retail.return.rejected`/`.closed` onto `retail_queue` (the
// producer-targets-consumer-queue split, ADR-008/020). `RETURN_WINDOW_DAYS` is a
// `ConfigService`-backed value provider resolving `RETURN_WINDOW_DAYS` (Joi default 30) so
// the Open use case injects a plain number (the inventory `RESERVATION_TTL_MINUTES`
// precedent). The `ReturnRpcExceptionFilter` is registered via `APP_FILTER` so it maps
// every handler's `ReturnDomainException` onto the wire status the gateway resolves.
@Module({
  imports: [
    DatabaseModule.forFeature([ReturnRequestEntity, ReturnLineEntity]),
    MicroserviceClientNotificationModule,
    MicroserviceClientRetailModule,
  ],
  controllers: [ReturnsController],
  providers: [
    ReturnRequestTypeormRepository,
    { provide: RETURN_REQUEST_REPOSITORY, useExisting: ReturnRequestTypeormRepository },

    ReturnOrderReaderTypeormAdapter,
    { provide: RETURN_ORDER_READER, useExisting: ReturnOrderReaderTypeormAdapter },

    ReturnRabbitmqPublisher,
    { provide: RETURN_EVENTS_PUBLISHER, useExisting: ReturnRabbitmqPublisher },

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
    CloseReturnUseCase,
    GetReturnUseCase,
    ListReturnsForOrderUseCase,

    { provide: APP_FILTER, useClass: ReturnRpcExceptionFilter },
  ],
  exports: [RETURN_REQUEST_REPOSITORY],
})
export class ReturnsModule {}
