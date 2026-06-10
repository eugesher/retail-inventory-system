import { Module } from '@nestjs/common';

import { NOTIFIER } from '../application/ports';
import { SendLowStockAlertUseCase, SendOrderNotificationUseCase } from '../application/use-cases';
import { HealthController } from '../presentation/health.controller';
import { InventoryEventsConsumer, OrderEventsConsumer } from './consumers';
import { LogNotifierAdapter } from './delivery';

// `NOTIFIER` is bound to `LogNotifierAdapter` today; swap to
// `EmailNotifierAdapter` / `WebhookNotifierAdapter` is a one-line `useExisting`
// rebind once those adapters are implemented (ADR-011 §3).
//
// Two event consumers are wired: `InventoryEventsConsumer` fans out the inventory
// low-stock alert (`inventory.stock.low`), and `OrderEventsConsumer` fans out the
// order-placed confirmation (`retail.order.placed`). Both translate a plain wire
// event into a use case that builds a `Notification` and dispatches it via `NOTIFIER`.
@Module({
  controllers: [HealthController, InventoryEventsConsumer, OrderEventsConsumer],
  providers: [
    SendLowStockAlertUseCase,
    SendOrderNotificationUseCase,
    LogNotifierAdapter,
    { provide: NOTIFIER, useExisting: LogNotifierAdapter },
  ],
})
export class NotificationsModule {}
