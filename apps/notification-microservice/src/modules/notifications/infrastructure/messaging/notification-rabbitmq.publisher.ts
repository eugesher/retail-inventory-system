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

// The notification context's event publisher and its sole `ClientProxy` holder (ADR-009 /
// ADR-020 / ADR-033) — the only file in the service permitted to import
// `@nestjs/microservices` for outbound emits. The retry use case has already built the
// versioned wire event; this adapter just emits it and waits for the broker ack.
//
// It emits through the `NOTIFICATION_MICROSERVICE` client, so the message lands on the
// service's **own** `notification_events` queue. There is no `@EventPattern` bound to
// `notifications.delivery.failed`, so the event is a reserved surface today — the
// downstream-alerting seam a future ops-alert / dead-letter capability binds. (A service
// emitting onto its own queue is the same client wiring the cross-service publishers use;
// the absence of a consumer is what makes it "reserved", not the destination.)
//
// The event is additionally **dual-published** (ADR-035): after the primary emit, the
// same routing key + wire is mirrored onto the `ris.events` topic exchange via the shared
// `RisEventsMirrorPublisher`, so the event-store firehose captures the delivery-failure
// stream. The mirror is best-effort and non-throwing, ordered after the primary emit.
@Injectable()
export class NotificationRabbitmqPublisher implements INotificationEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
  ) {}

  public async publishDeliveryFailed(event: INotificationDeliveryFailedEvent): Promise<void> {
    // `ClientProxy.emit()` is a cold Observable; `firstValueFrom` materializes it and
    // waits for the broker ack so the caller depends on a plain Promise (the
    // `ReturnRabbitmqPublisher` precedent).
    await firstValueFrom(
      this.notificationClient.emit<void, INotificationDeliveryFailedEvent>(
        ROUTING_KEYS.NOTIFICATIONS_DELIVERY_FAILED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.NOTIFICATIONS_DELIVERY_FAILED, event);
  }
}
