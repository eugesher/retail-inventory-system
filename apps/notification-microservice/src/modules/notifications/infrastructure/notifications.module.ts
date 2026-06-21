import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';

import {
  NOTIFICATION_DELIVERY_REPOSITORY,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  NOTIFIER,
  TEMPLATE_RENDERER,
} from '../application/ports';
import {
  AuthorTemplateUseCase,
  ListTemplatesUseCase,
  RenderAndDispatchUseCase,
  SendLowStockAlertUseCase,
  SendOrderNotificationUseCase,
  SendRefundNotificationUseCase,
  SendReturnNotificationUseCase,
  SendShipmentNotificationUseCase,
  SetTemplateActiveUseCase,
} from '../application/use-cases';
import { HealthController } from '../presentation/health.controller';
import { NotificationRpcExceptionFilter } from '../presentation/notification-rpc-exception.filter';
import { NotificationsController } from '../presentation/notifications.controller';
import {
  FulfillmentEventsConsumer,
  InventoryEventsConsumer,
  OrderEventsConsumer,
  RefundEventsConsumer,
  ReturnEventsConsumer,
} from './consumers';
import { LogNotifierAdapter } from './delivery';
import {
  NotificationDeliveryEntity,
  NotificationDeliveryTypeormRepository,
  NotificationTemplateEntity,
  NotificationTemplateTypeormRepository,
} from './persistence';
import { HandlebarsTemplateRendererAdapter } from './render';

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
// `NotificationsController` opens the service's first non-health `@MessagePattern`
// surface — the template authoring/read RPCs (`notification.template.author` /
// `.set-active` / `.list`, ADR-033) the gateway calls. `AuthorTemplateUseCase`
// (create-or-edit → a new `version`), `SetTemplateActiveUseCase`
// (activate/deactivate a version by id), and `ListTemplatesUseCase` (the filtered
// registry browse) back them, and the `APP_FILTER`-registered
// `NotificationRpcExceptionFilter` maps a thrown `NotificationDomainException` onto
// the wire `{ statusCode, message, code }` shape.
//
// Five event consumers are wired: `InventoryEventsConsumer` fans out the inventory
// low-stock alert (`inventory.stock.low`), `OrderEventsConsumer` fans out the
// order-placed confirmation (`retail.order.placed`), `FulfillmentEventsConsumer` fans
// out the two shipment lifecycle events (`retail.fulfillment.shipped` / `.delivered`),
// `ReturnEventsConsumer` fans out the four return lifecycle events
// (`retail.return.requested` / `.authorized` / `.received` / `.inspected`), and
// `RefundEventsConsumer` fans out the refund-issued confirmation
// (`retail.refund.issued`). Each translates a plain wire event into a use case that
// builds a `Notification` and dispatches it via `NOTIFIER`.
@Module({
  imports: [DatabaseModule.forFeature([NotificationTemplateEntity, NotificationDeliveryEntity])],
  controllers: [
    HealthController,
    NotificationsController,
    InventoryEventsConsumer,
    OrderEventsConsumer,
    FulfillmentEventsConsumer,
    ReturnEventsConsumer,
    RefundEventsConsumer,
  ],
  providers: [
    { provide: APP_FILTER, useClass: NotificationRpcExceptionFilter },
    AuthorTemplateUseCase,
    SetTemplateActiveUseCase,
    ListTemplatesUseCase,
    RenderAndDispatchUseCase,
    SendLowStockAlertUseCase,
    SendOrderNotificationUseCase,
    SendShipmentNotificationUseCase,
    SendReturnNotificationUseCase,
    SendRefundNotificationUseCase,
    LogNotifierAdapter,
    { provide: NOTIFIER, useExisting: LogNotifierAdapter },
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
  ],
})
export class NotificationsModule {}
