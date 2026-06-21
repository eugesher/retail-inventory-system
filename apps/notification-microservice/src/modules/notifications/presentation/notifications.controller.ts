import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  INotificationTemplateAuthorPayload,
  INotificationTemplateListPayload,
  INotificationTemplateSetActivePayload,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  AuthorTemplateUseCase,
  ListTemplatesUseCase,
  SetTemplateActiveUseCase,
} from '../application/use-cases';

// The notification microservice's first non-health `@MessagePattern` surface (ADR-033)
// — the template authoring/read RPCs the gateway calls, on `notification_events`. Until
// now the service had only `@EventPattern` consumers + the health ping; this opens the
// template registry to staff authoring.
//
// The handlers translate the wire payload into the use-case call; `correlationId` is
// logged inline inside each use case (`PinoLogger.assign()` throws outside request
// scope — ADR-001 / ADR-011 §7), so the controller carries no logging of its own. A
// thrown `NotificationDomainException` is mapped to the wire `{ statusCode, message,
// code }` shape by the `APP_FILTER`-registered `NotificationRpcExceptionFilter`.
@Controller()
export class NotificationsController {
  constructor(
    private readonly authorTemplateUseCase: AuthorTemplateUseCase,
    private readonly setTemplateActiveUseCase: SetTemplateActiveUseCase,
    private readonly listTemplatesUseCase: ListTemplatesUseCase,
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
}
