import { Module } from '@nestjs/common';

import { NOTIFIER } from '../application/ports';
import { SendLowStockAlertUseCase, SendOrderNotificationUseCase } from '../application/use-cases';
import { HealthController } from '../presentation/health.controller';
import { InventoryEventsConsumer, OrderEventsConsumer } from './consumers';
import { LogNotifierAdapter } from './delivery';

// Per-module wiring for the notifications bounded context. The `NOTIFIER`
// symbol is bound to `LogNotifierAdapter` today; swapping to
// `EmailNotifierAdapter` or `WebhookNotifierAdapter` is a one-line change to
// the `useClass` below once those adapters are implemented.
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
