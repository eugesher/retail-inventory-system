import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  INotificationDeliveryGetPayload,
  INotificationDeliveryListPayload,
  INotificationDeliveryRecordOutcomePayload,
  INotificationDeliveryRetryPayload,
  INotificationMarketingSendPayload,
  INotificationTemplateAuthorPayload,
  INotificationTemplateListPayload,
  INotificationTemplateSetActivePayload,
  IPage,
  NotificationDeliveryView,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  AuthorTemplateUseCase,
  GetDeliveryUseCase,
  ListDeliveriesUseCase,
  ListTemplatesUseCase,
  RecordDeliveryOutcomeUseCase,
  RetryDeliveryUseCase,
  SendMarketingUseCase,
  SetTemplateActiveUseCase,
} from '../application/use-cases';

@Controller()
export class NotificationsController {
  constructor(
    private readonly authorTemplateUseCase: AuthorTemplateUseCase,
    private readonly setTemplateActiveUseCase: SetTemplateActiveUseCase,
    private readonly listTemplatesUseCase: ListTemplatesUseCase,
    private readonly listDeliveriesUseCase: ListDeliveriesUseCase,
    private readonly getDeliveryUseCase: GetDeliveryUseCase,
    private readonly recordDeliveryOutcomeUseCase: RecordDeliveryOutcomeUseCase,
    private readonly retryDeliveryUseCase: RetryDeliveryUseCase,
    private readonly sendMarketingUseCase: SendMarketingUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.NOTIFICATION_TEMPLATE_AUTHOR)
  public async authorTemplate(
    @Payload() payload: INotificationTemplateAuthorPayload,
  ): Promise<NotificationTemplateView> {
    return this.authorTemplateUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.NOTIFICATION_TEMPLATE_SET_ACTIVE)
  public async setTemplateActive(
    @Payload() payload: INotificationTemplateSetActivePayload,
  ): Promise<NotificationTemplateView> {
    return this.setTemplateActiveUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.NOTIFICATION_TEMPLATE_LIST)
  public async listTemplates(
    @Payload() payload: INotificationTemplateListPayload,
  ): Promise<NotificationTemplateView[]> {
    return this.listTemplatesUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.NOTIFICATION_DELIVERY_LIST)
  public async listDeliveries(
    @Payload() payload: INotificationDeliveryListPayload,
  ): Promise<IPage<NotificationDeliveryView>> {
    return this.listDeliveriesUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.NOTIFICATION_DELIVERY_GET)
  public async getDelivery(
    @Payload() payload: INotificationDeliveryGetPayload,
  ): Promise<NotificationDeliveryView> {
    return this.getDeliveryUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.NOTIFICATION_DELIVERY_RECORD_OUTCOME)
  public async recordDeliveryOutcome(
    @Payload() payload: INotificationDeliveryRecordOutcomePayload,
  ): Promise<NotificationDeliveryView> {
    return this.recordDeliveryOutcomeUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.NOTIFICATION_DELIVERY_RETRY)
  public async retryDelivery(
    @Payload() payload: INotificationDeliveryRetryPayload,
  ): Promise<NotificationDeliveryView> {
    return this.retryDeliveryUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.NOTIFICATION_MARKETING_SEND)
  public async sendMarketing(
    @Payload() payload: INotificationMarketingSendPayload,
  ): Promise<NotificationDeliveryView | null> {
    return this.sendMarketingUseCase.execute(payload);
  }
}
