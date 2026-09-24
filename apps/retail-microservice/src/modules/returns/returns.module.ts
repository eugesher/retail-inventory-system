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
  OCC_RETRY_ATTEMPTS,
  RETURN_CUSTOMER_CONTACT_READER,
  RETURN_EVENTS_PUBLISHER,
  RETURN_ORDER_READER,
  RETURN_REQUEST_REPOSITORY,
  RETURN_WINDOW_DAYS,
  RETURNS_UNIT_OF_WORK,
} from './application/ports';
import {
  AuthorizeReturnUseCase,
  CloseReturnUseCase,
  GetReturnUseCase,
  InspectAndDispositionUseCase,
  ListReturnsForOrderUseCase,
  OpenReturnRequestUseCase,
  ReceiveReturnUseCase,
  RejectReturnUseCase,
} from './application/use-cases';
import {
  InventoryRestockRabbitmqAdapter,
  ReturnRabbitmqPublisher,
} from './infrastructure/messaging';
import {
  CustomerContactReaderTypeormAdapter,
  ReturnOrderReaderTypeormAdapter,
  ReturnRequestTypeormRepository,
  ReturnsUnitOfWorkAdapter,
  returnEntities,
} from './infrastructure/persistence';
import { ReturnsController, ReturnRpcExceptionFilter } from './presentation';

@Module({
  imports: [
    DatabaseModule.forFeature(returnEntities),
    MicroserviceClientNotificationModule,
    MicroserviceClientRetailModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientRisEventsModule,
  ],
  controllers: [ReturnsController],
  providers: [
    ReturnRequestTypeormRepository,
    { provide: RETURN_REQUEST_REPOSITORY, useExisting: ReturnRequestTypeormRepository },

    ReturnsUnitOfWorkAdapter,
    { provide: RETURNS_UNIT_OF_WORK, useExisting: ReturnsUnitOfWorkAdapter },

    ReturnOrderReaderTypeormAdapter,
    { provide: RETURN_ORDER_READER, useExisting: ReturnOrderReaderTypeormAdapter },

    CustomerContactReaderTypeormAdapter,
    { provide: RETURN_CUSTOMER_CONTACT_READER, useExisting: CustomerContactReaderTypeormAdapter },

    ReturnRabbitmqPublisher,
    { provide: RETURN_EVENTS_PUBLISHER, useExisting: ReturnRabbitmqPublisher },

    InventoryRestockRabbitmqAdapter,
    { provide: INVENTORY_RESTOCK_GATEWAY, useExisting: InventoryRestockRabbitmqAdapter },

    {
      provide: RETURN_WINDOW_DAYS,
      useFactory: (config: ConfigService): number => config.get<number>('RETURN_WINDOW_DAYS') ?? 30,
      inject: [ConfigService],
    },
    {
      provide: OCC_RETRY_ATTEMPTS,
      useFactory: (config: ConfigService): number => config.get<number>('OCC_RETRY_ATTEMPTS') ?? 5,
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
