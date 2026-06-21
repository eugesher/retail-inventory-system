import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { DatabaseModule } from '@retail-inventory-system/database';
import { MicroserviceClientNotificationModule } from '@retail-inventory-system/messaging';

import {
  INotifierPort,
  MAX_DELIVERY_ATTEMPTS,
  NOTIFICATION_DELIVERY_REPOSITORY,
  NOTIFICATION_EVENTS_PUBLISHER,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  NOTIFIER,
  OPS_NOTIFICATIONS_EMAIL,
  TEMPLATE_RENDERER,
} from '../application/ports';
import {
  AuthorTemplateUseCase,
  GetDeliveryUseCase,
  ListDeliveriesUseCase,
  ListTemplatesUseCase,
  RecordDeliveryOutcomeUseCase,
  RenderAndDispatchUseCase,
  RetryDeliveryUseCase,
  RetryFailedDeliveriesUseCase,
  SetTemplateActiveUseCase,
} from '../application/use-cases';
import { HealthController } from '../presentation/health.controller';
import { NotificationRpcExceptionFilter } from '../presentation/notification-rpc-exception.filter';
import { NotificationsController } from '../presentation/notifications.controller';
import {
  FulfillmentEventsConsumer,
  InventoryEventsConsumer,
  OrderCancelledNotificationConsumer,
  OrderEventsConsumer,
  RefundEventsConsumer,
  ReturnEventsConsumer,
} from './consumers';
import { FlakyLogNotifierAdapter, LogNotifierAdapter } from './delivery';
import { NotificationRabbitmqPublisher } from './messaging';
import {
  NotificationDeliveryEntity,
  NotificationDeliveryTypeormRepository,
  NotificationTemplateEntity,
  NotificationTemplateTypeormRepository,
} from './persistence';
import { HandlebarsTemplateRendererAdapter } from './render';
import { DeliveryRetryScheduler } from './scheduling';

// `NOTIFIER` is bound to `LogNotifierAdapter` today; swap to
// `EmailNotifierAdapter` / `WebhookNotifierAdapter` is a one-line `useExisting`
// rebind once those adapters are implemented (ADR-011 §3).
//
// `TEMPLATE_RENDERER` is bound to `HandlebarsTemplateRendererAdapter` — the seam
// the `RenderAndDispatchUseCase` renders a template subject/body against an event
// context through. The Handlebars engine import is confined to
// `infrastructure/render/` (ADR-004/017, ADR-033).
//
// `DatabaseModule.forFeature([...])` registers the two persistence entities the
// notification microservice owns (its first DB tables, ADR-033). The two repository
// ports (`NOTIFICATION_TEMPLATE_REPOSITORY` / `NOTIFICATION_DELIVERY_REPOSITORY`) are
// bound to their TypeORM adapters here. `RenderAndDispatchUseCase` is the first
// consumer of all four seams (template repo + delivery repo + renderer + `NOTIFIER`):
// it resolves the latest active template, renders subject/body, persists a `queued`
// `NotificationDelivery` row BEFORE the `NOTIFIER` call, then flips it `→ sent`/`→ failed`.
// The consumers are rewired onto it in a later capability; the five inline use cases
// still run unchanged today.
//
// `NotificationsController` serves the service's non-health `@MessagePattern` surface
// (ADR-033): the template authoring/read RPCs (`notification.template.author` /
// `.set-active` / `.list`) the gateway calls — backed by `AuthorTemplateUseCase`
// (create-or-edit → a new `version`), `SetTemplateActiveUseCase` (activate/deactivate
// a version by id), and `ListTemplatesUseCase` (the filtered registry browse) — plus
// the delivery audit reads + record-outcome RPCs (`notification.delivery.list` /
// `.get` / `.record-outcome`) backed by `ListDeliveriesUseCase` (the paginated,
// filterable audit read), `GetDeliveryUseCase` (one full delivery row by id), and
// `RecordDeliveryOutcomeUseCase` (the ESP-webhook seam — `sent → delivered|bounced`;
// the webhook ingestion itself is a documented stub, RPC-only). The
// `APP_FILTER`-registered `NotificationRpcExceptionFilter` maps a thrown
// `NotificationDomainException` onto the wire `{ statusCode, message, code }` shape.
//
// Six event consumers are wired, and EVERY one now routes its wire event through
// `RenderAndDispatchUseCase` (the template-driven persist-then-send pipeline, ADR-033) —
// the inline per-event send use cases they used to call are deleted. Each consumer owns
// only the event → `IRenderAndDispatchInput` mapping (`eventType`, reference type/id,
// recipient, render context):
// `InventoryEventsConsumer` fans out the inventory low-stock alert
// (`inventory.stock.low`) to the ops mailbox (`OPS_NOTIFICATIONS_EMAIL`, a null-recipient
// system row); `OrderEventsConsumer` the order-placed confirmation
// (`retail.order.placed`); `OrderCancelledNotificationConsumer` the cancellation
// confirmation (`retail.order.cancelled` — the notification-side consumer on
// `notification_events`, distinct from the retail-side auto-refund consumer on
// `retail_queue`); `FulfillmentEventsConsumer` the two shipment lifecycle events
// (`retail.fulfillment.shipped` / `.delivered`); `ReturnEventsConsumer` the four return
// lifecycle events (`retail.return.requested` / `.authorized` / `.received` /
// `.inspected`); and `RefundEventsConsumer` the refund-issued confirmation
// (`retail.refund.issued`). A customer-facing event whose `customerEmail` is null
// warn-logs and skips (the shared `dispatchCustomerEmailNotification` helper) — there is
// no one to notify. `OPS_NOTIFICATIONS_EMAIL` is a `ConfigService` value provider (Joi
// default `ops@example.com`, the `MAX_DELIVERY_ATTEMPTS` precedent).
//
// The retry capability is wired here too (ADR-033). `RetryDeliveryUseCase` is the manual
// `notification.delivery.retry` RPC; `RetryFailedDeliveriesUseCase` is the scheduled
// sweeper, driven by `DeliveryRetryScheduler` (an `@nestjs/schedule` `@Interval`,
// discovered by `ScheduleModule.forRoot()`). Both re-dispatch the already-rendered content
// via `NOTIFIER` and, at the `MAX_DELIVERY_ATTEMPTS` cap, emit `notifications.delivery.failed`
// through `NOTIFICATION_EVENTS_PUBLISHER` → `NotificationRabbitmqPublisher` (the sole
// `ClientProxy` holder, emitting onto the service's own `notification_events` queue — a
// reserved alerting surface, no consumer). `MicroserviceClientNotificationModule` supplies
// that client; `MAX_DELIVERY_ATTEMPTS` is a `ConfigService` value provider (Joi default 3,
// the retail `RETURN_WINDOW_DAYS` precedent).
@Module({
  imports: [
    DatabaseModule.forFeature([NotificationTemplateEntity, NotificationDeliveryEntity]),
    MicroserviceClientNotificationModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [
    HealthController,
    NotificationsController,
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
    RenderAndDispatchUseCase,
    LogNotifierAdapter,
    FlakyLogNotifierAdapter,
    // `NOTIFIER` is `LogNotifierAdapter` by default. When `NOTIFIER_TEST_FLAKY` is set
    // (the test infra / a retry e2e suite turns it on; production never does), the
    // deterministically-flaky `FlakyLogNotifierAdapter` is selected instead — it fails a
    // delivery whose rendered body carries the test marker exactly once, so the retry path
    // (failed → retry → sent) can be exercised end to end. It is inert for every non-marker
    // delivery, so other suites are unaffected even with the flag on (ADR-033).
    //
    // The flag is read straight off `process.env` (not via `ConfigService`) DELIBERATELY:
    // `ConfigModule.forRoot` validates `process.env` when the `@Module` decorator is
    // evaluated (at AppModule import time), so a value an e2e suite sets in `beforeAll`
    // would be missed by `ConfigService`. This factory runs at DI-init time — after the
    // suite has set the flag — so the live `process.env` read picks it up.
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
    NotificationRabbitmqPublisher,
    { provide: NOTIFICATION_EVENTS_PUBLISHER, useExisting: NotificationRabbitmqPublisher },
    // The per-delivery retry cap, resolved from `MAX_DELIVERY_ATTEMPTS` (Joi default 3) so
    // the retry use cases inject a plain number rather than reading env (the retail
    // `RETURN_WINDOW_DAYS` value-provider precedent, ADR-033).
    {
      provide: MAX_DELIVERY_ATTEMPTS,
      useFactory: (config: ConfigService): number =>
        config.get<number>('MAX_DELIVERY_ATTEMPTS') ?? 3,
      inject: [ConfigService],
    },
    // The operations mailbox a system/ops notification (today only the low-stock alert) is
    // sent to, resolved from `OPS_NOTIFICATIONS_EMAIL` (Joi default `ops@example.com`) so
    // the consumer injects a plain string rather than reading env (the `MAX_DELIVERY_ATTEMPTS`
    // value-provider precedent, ADR-033).
    {
      provide: OPS_NOTIFICATIONS_EMAIL,
      useFactory: (config: ConfigService): string =>
        config.get<string>('OPS_NOTIFICATIONS_EMAIL') ?? 'ops@example.com',
      inject: [ConfigService],
    },
  ],
})
export class NotificationsModule {}
