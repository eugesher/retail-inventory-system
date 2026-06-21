import { Module } from '@nestjs/common';

import { MicroserviceClientNotificationModule } from '@retail-inventory-system/messaging';

import { NOTIFICATIONS_GATEWAY_PORT } from './application/ports';
import {
  AuthorTemplateUseCase,
  GetDeliveryUseCase,
  ListDeliveriesUseCase,
  ListTemplatesUseCase,
  RetryDeliveryUseCase,
  SetTemplateActiveUseCase,
} from './application/use-cases';
import { NotificationsRabbitmqAdapter } from './infrastructure/messaging';
import { NotificationsController } from './presentation';

// Gateway-side port→adapter module fronting the notification microservice's
// template + delivery RPCs over HTTP at `/api/notifications` (ADR-009). Named after
// the downstream service, not the URL prefix. `NotificationsRabbitmqAdapter` (the
// sole `ClientProxy` holder) backs `NOTIFICATIONS_GATEWAY_PORT`; the six thin use
// cases and the controller depend on the port symbol only.
@Module({
  imports: [MicroserviceClientNotificationModule],
  controllers: [NotificationsController],
  providers: [
    AuthorTemplateUseCase,
    SetTemplateActiveUseCase,
    ListTemplatesUseCase,
    ListDeliveriesUseCase,
    GetDeliveryUseCase,
    RetryDeliveryUseCase,
    { provide: NOTIFICATIONS_GATEWAY_PORT, useClass: NotificationsRabbitmqAdapter },
  ],
})
export class NotificationsModule {}
