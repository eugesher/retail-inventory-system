import { Module } from '@nestjs/common';

import { NOTIFIER } from '../application/ports';
import { SendLowStockAlertUseCase, SendOrderNotificationUseCase } from '../application/use-cases';
import { HealthController } from '../presentation/health.controller';
import { InventoryEventsConsumer, OrderEventsConsumer } from './consumers';
import { LogNotifierAdapter } from './delivery';

// `NOTIFIER` is bound to `LogNotifierAdapter` today; swap to
// `EmailNotifierAdapter` / `WebhookNotifierAdapter` is a one-line `useExisting`
// rebind once those adapters are implemented (ADR-011 §3).
@Module({
  controllers: [HealthController, OrderEventsConsumer, InventoryEventsConsumer],
  providers: [
    SendOrderNotificationUseCase,
    SendLowStockAlertUseCase,
    LogNotifierAdapter,
    { provide: NOTIFIER, useExisting: LogNotifierAdapter },
  ],
})
export class NotificationsModule {}
