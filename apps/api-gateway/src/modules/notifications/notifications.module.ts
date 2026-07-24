import { Module } from '@nestjs/common';

import { MicroserviceClientNotificationModule } from '@retail-inventory-system/messaging';

import { NOTIFICATIONS_GATEWAY_PORT } from './application/ports';
import {
  AuthorTemplateUseCase,
  GetDeliveryUseCase,
  ListDeliveriesUseCase,
  ListTemplatesUseCase,
  RetryDeliveryUseCase,
  SendMarketingUseCase,
  SetTemplateActiveUseCase,
} from './application/use-cases';
import { NotificationsRabbitmqAdapter } from './infrastructure/messaging';
import { NotificationsController } from './presentation';

// Gateway-side port→adapter module fronting the notification microservice's
// template + delivery RPCs over HTTP at `/api/notifications` (ADR-009). Named after
// the downstream service, not the URL prefix. `NotificationsRabbitmqAdapter` (the
// sole `ClientProxy` holder) backs `NOTIFICATIONS_GATEWAY_PORT`; the seven thin use
// cases and the controller depend on the port symbol only.
//
// Seven, because `SendMarketingUseCase` joined the original six with ADR-037. It is the odd one
// out in kind, not just in count: the other six administer notifications (author, roll back,
// browse, audit, retry), while this one *causes* one — and the consent gate that decides whether
// it actually sends lives downstream, in the notification service, not here.
//
// `notification.delivery.record-outcome` is the one non-health RPC with no route in this module,
// and the port omits `recordOutcome` deliberately: a real ESP-webhook bridge needs signature
// verification and provider-payload mapping, and a plain authenticated POST would let a caller
// forge delivery outcomes.
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
    SendMarketingUseCase,
    { provide: NOTIFICATIONS_GATEWAY_PORT, useClass: NotificationsRabbitmqAdapter },
  ],
})
export class NotificationsModule {}
