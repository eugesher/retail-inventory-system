import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { INotificationDeliveryFailedEvent } from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  RisEventsMirrorPublisher,
  ROUTING_KEYS,
} from '@retail-inventory-system/messaging';

import { INotificationEventsPublisherPort } from '../../application/ports';

@Injectable()
export class NotificationRabbitmqPublisher implements INotificationEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
  ) {}

  public async publishDeliveryFailed(event: INotificationDeliveryFailedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, INotificationDeliveryFailedEvent>(
        ROUTING_KEYS.NOTIFICATIONS_DELIVERY_FAILED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.NOTIFICATIONS_DELIVERY_FAILED, event);
  }
}
