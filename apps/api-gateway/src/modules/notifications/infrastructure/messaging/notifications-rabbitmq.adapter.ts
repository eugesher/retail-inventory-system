import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  INotificationDeliveryGetPayload,
  INotificationDeliveryListPayload,
  INotificationDeliveryRetryPayload,
  INotificationTemplateAuthorPayload,
  INotificationTemplateListPayload,
  INotificationTemplateSetActivePayload,
  IPage,
  NotificationDeliveryView,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IAuthorTemplateCommand,
  IGetDeliveryQuery,
  IListDeliveriesQuery,
  IListTemplatesQuery,
  INotificationsGatewayPort,
  IRetryDeliveryCommand,
  ISetTemplateActiveCommand,
} from '../../application/ports';

// The single `ClientProxy` holder for the notifications gateway module (ADR-009 /
// ADR-020). Each method materializes the RPC with `firstValueFrom` and stitches the
// transport-level `correlationId` onto the wire payload; everything else in the
// module depends on `INotificationsGatewayPort`, never on `@nestjs/microservices`.
// The RPCs land on `notification_events` (the notification service's queue) via the
// `NOTIFICATION_MICROSERVICE` client.
@Injectable()
export class NotificationsRabbitmqAdapter implements INotificationsGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async authorTemplate(
    command: IAuthorTemplateCommand,
    correlationId: string,
  ): Promise<NotificationTemplateView> {
    return firstValueFrom(
      this.client.send<NotificationTemplateView, INotificationTemplateAuthorPayload>(
        ROUTING_KEYS.NOTIFICATION_TEMPLATE_AUTHOR,
        { ...command, correlationId },
      ),
    );
  }

  public async setTemplateActive(
    command: ISetTemplateActiveCommand,
    correlationId: string,
  ): Promise<NotificationTemplateView> {
    return firstValueFrom(
      this.client.send<NotificationTemplateView, INotificationTemplateSetActivePayload>(
        ROUTING_KEYS.NOTIFICATION_TEMPLATE_SET_ACTIVE,
        { ...command, correlationId },
      ),
    );
  }

  public async listTemplates(
    query: IListTemplatesQuery,
    correlationId: string,
  ): Promise<NotificationTemplateView[]> {
    return firstValueFrom(
      this.client.send<NotificationTemplateView[], INotificationTemplateListPayload>(
        ROUTING_KEYS.NOTIFICATION_TEMPLATE_LIST,
        { ...query, correlationId },
      ),
    );
  }

  public async listDeliveries(
    query: IListDeliveriesQuery,
    correlationId: string,
  ): Promise<IPage<NotificationDeliveryView>> {
    return firstValueFrom(
      this.client.send<IPage<NotificationDeliveryView>, INotificationDeliveryListPayload>(
        ROUTING_KEYS.NOTIFICATION_DELIVERY_LIST,
        { ...query, correlationId },
      ),
    );
  }

  public async getDelivery(
    query: IGetDeliveryQuery,
    correlationId: string,
  ): Promise<NotificationDeliveryView> {
    return firstValueFrom(
      this.client.send<NotificationDeliveryView, INotificationDeliveryGetPayload>(
        ROUTING_KEYS.NOTIFICATION_DELIVERY_GET,
        { ...query, correlationId },
      ),
    );
  }

  public async retryDelivery(
    command: IRetryDeliveryCommand,
    correlationId: string,
  ): Promise<NotificationDeliveryView> {
    return firstValueFrom(
      this.client.send<NotificationDeliveryView, INotificationDeliveryRetryPayload>(
        ROUTING_KEYS.NOTIFICATION_DELIVERY_RETRY,
        { ...command, correlationId },
      ),
    );
  }
}
