import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientNotificationModule,
  MicroserviceClientRisEventsModule,
} from '@retail-inventory-system/messaging';

import {
  CONSENT_CACHE,
  CONSENT_CACHE_TTL_SECONDS,
  CONSENT_READER,
  INotifierPort,
  MAX_DELIVERY_ATTEMPTS,
  RETENTION_DELIVERY_DAYS,
  NOTIFICATION_DELIVERY_REPOSITORY,
  NOTIFICATION_EVENTS_PUBLISHER,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  NOTIFIER,
  OPS_NOTIFICATIONS_EMAIL,
  TEMPLATE_RENDERER,
} from './application/ports';
import {
  AuthorTemplateUseCase,
  GetDeliveryUseCase,
  ListDeliveriesUseCase,
  ListTemplatesUseCase,
  RecordDeliveryOutcomeUseCase,
  RenderAndDispatchUseCase,
  RetryDeliveryUseCase,
  PurgeAgedDeliveriesUseCase,
  RetryFailedDeliveriesUseCase,
  SendMarketingUseCase,
  SetTemplateActiveUseCase,
} from './application/use-cases';
import { NotificationRpcExceptionFilter } from './presentation/notification-rpc-exception.filter';
import { NotificationsController } from './presentation/notifications.controller';
import { ConsentCache } from './infrastructure/cache';
import {
  ConsentEventsConsumer,
  FulfillmentEventsConsumer,
  InventoryEventsConsumer,
  OrderCancelledNotificationConsumer,
  OrderEventsConsumer,
  RefundEventsConsumer,
  ReturnEventsConsumer,
} from './infrastructure/consumers';
import { FlakyLogNotifierAdapter, LogNotifierAdapter } from './infrastructure/delivery';
import { NotificationRabbitmqPublisher } from './infrastructure/messaging';
import {
  ConsentReaderTypeormAdapter,
  NotificationDeliveryTypeormRepository,
  NotificationTemplateTypeormRepository,
  notificationEntities,
} from './infrastructure/persistence';
import { HandlebarsTemplateRendererAdapter } from './infrastructure/render';
import { DeliveryRetentionScheduler, DeliveryRetryScheduler } from './infrastructure/scheduling';

@Module({
  imports: [
    DatabaseModule.forFeature(notificationEntities),
    MicroserviceClientNotificationModule,
    MicroserviceClientRisEventsModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [
    NotificationsController,
    ConsentEventsConsumer,
    InventoryEventsConsumer,
    OrderEventsConsumer,
    OrderCancelledNotificationConsumer,
    FulfillmentEventsConsumer,
    ReturnEventsConsumer,
    RefundEventsConsumer,
  ],
  providers: [
    { provide: APP_FILTER, useClass: NotificationRpcExceptionFilter },
    AuthorTemplateUseCase,
    SetTemplateActiveUseCase,
    ListTemplatesUseCase,
    ListDeliveriesUseCase,
    GetDeliveryUseCase,
    RecordDeliveryOutcomeUseCase,
    RetryDeliveryUseCase,
    RetryFailedDeliveriesUseCase,
    DeliveryRetryScheduler,

    PurgeAgedDeliveriesUseCase,
    DeliveryRetentionScheduler,
    RenderAndDispatchUseCase,
    SendMarketingUseCase,
    LogNotifierAdapter,
    FlakyLogNotifierAdapter,
    {
      provide: NOTIFIER,
      useFactory: (log: LogNotifierAdapter, flaky: FlakyLogNotifierAdapter): INotifierPort =>
        process.env.NOTIFIER_TEST_FLAKY === 'true' ? flaky : log,
      inject: [LogNotifierAdapter, FlakyLogNotifierAdapter],
    },
    HandlebarsTemplateRendererAdapter,
    { provide: TEMPLATE_RENDERER, useExisting: HandlebarsTemplateRendererAdapter },
    NotificationTemplateTypeormRepository,
    {
      provide: NOTIFICATION_TEMPLATE_REPOSITORY,
      useExisting: NotificationTemplateTypeormRepository,
    },
    NotificationDeliveryTypeormRepository,
    {
      provide: NOTIFICATION_DELIVERY_REPOSITORY,
      useExisting: NotificationDeliveryTypeormRepository,
    },
    ConsentReaderTypeormAdapter,
    { provide: CONSENT_READER, useExisting: ConsentReaderTypeormAdapter },
    ConsentCache,
    { provide: CONSENT_CACHE, useExisting: ConsentCache },
    NotificationRabbitmqPublisher,
    { provide: NOTIFICATION_EVENTS_PUBLISHER, useExisting: NotificationRabbitmqPublisher },
    {
      provide: RETENTION_DELIVERY_DAYS,
      useFactory: (config: ConfigService): number =>
        config.get<number>('RETENTION_DELIVERY_DAYS') ?? 90,
      inject: [ConfigService],
    },
    {
      provide: MAX_DELIVERY_ATTEMPTS,
      useFactory: (config: ConfigService): number =>
        config.get<number>('MAX_DELIVERY_ATTEMPTS') ?? 3,
      inject: [ConfigService],
    },
    {
      provide: OPS_NOTIFICATIONS_EMAIL,
      useFactory: (config: ConfigService): string =>
        config.get<string>('OPS_NOTIFICATIONS_EMAIL') ?? 'ops@example.com',
      inject: [ConfigService],
    },
    {
      provide: CONSENT_CACHE_TTL_SECONDS,
      useFactory: (config: ConfigService): number =>
        config.get<number>('NOTIFICATIONS_CONSENT_CACHE_TTL_SECONDS') ?? 300,
      inject: [ConfigService],
    },
  ],
})
export class NotificationsModule {}
