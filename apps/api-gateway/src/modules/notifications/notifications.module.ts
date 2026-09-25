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
