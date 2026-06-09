import { Module } from '@nestjs/common';

import { NOTIFIER } from '../application/ports';
import { SendLowStockAlertUseCase } from '../application/use-cases';
import { HealthController } from '../presentation/health.controller';
import { InventoryEventsConsumer } from './consumers';
import { LogNotifierAdapter } from './delivery';

// `NOTIFIER` is bound to `LogNotifierAdapter` today; swap to
// `EmailNotifierAdapter` / `WebhookNotifierAdapter` is a one-line `useExisting`
// rebind once those adapters are implemented (ADR-011 §3).
//
// Only the low-stock consumer is wired today — the order-notification consumer
// was retired alongside the legacy retail order model and is re-introduced
// against the rebuilt order-placed event by a later capability.
@Module({
  controllers: [HealthController, InventoryEventsConsumer],
  providers: [
    SendLowStockAlertUseCase,
    LogNotifierAdapter,
    { provide: NOTIFIER, useExisting: LogNotifierAdapter },
  ],
})
export class NotificationsModule {}
