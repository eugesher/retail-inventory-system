import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  INotificationDeliveryGetPayload,
  INotificationDeliveryListPayload,
  INotificationDeliveryRecordOutcomePayload,
  INotificationDeliveryRetryPayload,
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
  SetTemplateActiveUseCase,
} from '../application/use-cases';

// The notification microservice's non-health `@MessagePattern` surface (ADR-033) — the
// template authoring/read RPCs + the delivery audit reads + the record-outcome RPC the
// gateway calls, on `notification_events`. Until ADR-033 the service had only
// `@EventPattern` consumers + the health ping; this opens the template registry to staff
// authoring and the delivery trail to staff querying.
//
// The handlers translate the wire payload into the use-case call; `correlationId` is
// logged inline inside each use case (`PinoLogger.assign()` throws outside request
// scope — ADR-001 / ADR-011 §7), so the controller carries no logging of its own. A
// thrown `NotificationDomainException` is mapped to the wire `{ statusCode, message,
// code }` shape by the `APP_FILTER`-registered `NotificationRpcExceptionFilter`.
//
// `record-outcome` is the ESP-webhook seam — the internal RPC a future provider-webhook
// bridge (HTTP endpoint + signature verification + payload mapping) would call. That
// bridge is out of scope this capability, so there is no gateway HTTP route for it; the
// `list`/`get` reads do get gateway routes (a later capability).
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

  // The operator manual-retry of one `failed` delivery — re-dispatches the
  // already-rendered content, forcing past the scheduled sweeper's backoff gate (ADR-033).
  // The gateway manual-retry HTTP route that fronts this RPC is a later capability.
  @MessagePattern(ROUTING_KEYS.NOTIFICATION_DELIVERY_RETRY)
  public async retryDelivery(
    @Payload() payload: INotificationDeliveryRetryPayload,
  ): Promise<NotificationDeliveryView> {
    return this.retryDeliveryUseCase.execute(payload);
  }
}
