import { Module } from '@nestjs/common';

import { NOTIFIER } from '../application/ports';
import {
  SendLowStockAlertUseCase,
  SendOrderNotificationUseCase,
  SendShipmentNotificationUseCase,
} from '../application/use-cases';
import { HealthController } from '../presentation/health.controller';
import {
  FulfillmentEventsConsumer,
  InventoryEventsConsumer,
  OrderEventsConsumer,
} from './consumers';
import { LogNotifierAdapter } from './delivery';

// `NOTIFIER` is bound to `LogNotifierAdapter` today; swap to
// `EmailNotifierAdapter` / `WebhookNotifierAdapter` is a one-line `useExisting`
// rebind once those adapters are implemented (ADR-011 §3).
//
// Three event consumers are wired: `InventoryEventsConsumer` fans out the inventory
// low-stock alert (`inventory.stock.low`), `OrderEventsConsumer` fans out the
// order-placed confirmation (`retail.order.placed`), and `FulfillmentEventsConsumer`
// fans out the two shipment lifecycle events (`retail.fulfillment.shipped` /
// `.delivered`). Each translates a plain wire event into a use case that builds a
// `Notification` and dispatches it via `NOTIFIER`.
@Module({
  controllers: [
    HealthController,
    InventoryEventsConsumer,
    OrderEventsConsumer,
    FulfillmentEventsConsumer,
  ],
  providers: [
    SendLowStockAlertUseCase,
    SendOrderNotificationUseCase,
    SendShipmentNotificationUseCase,
    LogNotifierAdapter,
    { provide: NOTIFIER, useExisting: LogNotifierAdapter },
  ],
})
export class NotificationsModule {}
