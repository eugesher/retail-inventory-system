import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import {
  NOTIFICATION_DELIVERY_REPOSITORY,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  NOTIFIER,
} from '../application/ports';
import {
  SendLowStockAlertUseCase,
  SendOrderNotificationUseCase,
  SendRefundNotificationUseCase,
  SendReturnNotificationUseCase,
  SendShipmentNotificationUseCase,
} from '../application/use-cases';
import { HealthController } from '../presentation/health.controller';
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

// `NOTIFIER` is bound to `LogNotifierAdapter` today; swap to
// `EmailNotifierAdapter` / `WebhookNotifierAdapter` is a one-line `useExisting`
// rebind once those adapters are implemented (ADR-011 §3).
//
// `DatabaseModule.forFeature([...])` registers the two persistence entities the
// notification microservice now owns (its first DB tables, ADR-033). The two repository
// ports (`NOTIFICATION_TEMPLATE_REPOSITORY` / `NOTIFICATION_DELIVERY_REPOSITORY`) are
// bound to their TypeORM adapters here so they are injectable, even though no use case
// resolves them yet — the renderer (a later capability) and Render & Dispatch are the
// first consumers; the foundation only wires the seam.
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
    InventoryEventsConsumer,
    OrderEventsConsumer,
    FulfillmentEventsConsumer,
    ReturnEventsConsumer,
    RefundEventsConsumer,
  ],
  providers: [
    SendLowStockAlertUseCase,
    SendOrderNotificationUseCase,
    SendShipmentNotificationUseCase,
    SendReturnNotificationUseCase,
    SendRefundNotificationUseCase,
    LogNotifierAdapter,
    { provide: NOTIFIER, useExisting: LogNotifierAdapter },
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
