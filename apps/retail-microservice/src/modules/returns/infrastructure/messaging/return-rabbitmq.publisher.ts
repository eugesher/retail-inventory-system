import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IRetailReturnAuthorizedEvent,
  IRetailReturnClosedEvent,
  IRetailReturnInspectedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRejectedEvent,
  IRetailReturnRequestedEvent,
} from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  RisEventsMirrorPublisher,
  ROUTING_KEYS,
} from '@retail-inventory-system/messaging';

import { IReturnEventsPublisherPort } from '../../application/ports';

// The returns context's event publisher and its sole `ClientProxy` holder (ADR-009 /
// ADR-020). The use case has already built the versioned wire event; this adapter just
// emits it and waits for the broker ack.
//
// Two destinations, by the producer-targets-consumer-queue pattern (ADR-008/020) — the
// `OrderRabbitmqPublisher` two-client precedent. The buyer-facing
// `retail.return.requested` / `.authorized` / `.received` are emitted through the
// `NOTIFICATION_MICROSERVICE` client so they land on `notification_events` (the
// notification service's own queue, where it binds a returns fan-out consumer); the
// internal-status `retail.return.rejected` / `.closed` are emitted through the
// `RETAIL_MICROSERVICE` client onto `retail_queue` (the producer's own queue — reserved
// surfaces today, no consumer).
//
// Every event is additionally **dual-published** (ADR-035): after the primary emit, the
// same routing key + wire is mirrored onto the `ris.events` topic exchange via the shared
// `RisEventsMirrorPublisher`, so the event-store firehose captures the whole RMA lifecycle.
// The mirror is best-effort and non-throwing, ordered after the primary emit.
@Injectable()
export class ReturnRabbitmqPublisher implements IReturnEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
  ) {}

  public async publishReturnRequested(event: IRetailReturnRequestedEvent): Promise<void> {
    // `ClientProxy.emit()` is a cold Observable; `firstValueFrom` materializes it and
    // waits for the broker ack so callers depend on a plain Promise.
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailReturnRequestedEvent>(
        ROUTING_KEYS.RETAIL_RETURN_REQUESTED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_RETURN_REQUESTED, event);
  }

  public async publishReturnAuthorized(event: IRetailReturnAuthorizedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailReturnAuthorizedEvent>(
        ROUTING_KEYS.RETAIL_RETURN_AUTHORIZED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_RETURN_AUTHORIZED, event);
  }

  public async publishReturnReceived(event: IRetailReturnReceivedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailReturnReceivedEvent>(
        ROUTING_KEYS.RETAIL_RETURN_RECEIVED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_RETURN_RECEIVED, event);
  }

  // `retail.return.inspected` rides the `NOTIFICATION_MICROSERVICE` client onto
  // `notification_events` (the buyer-facing inspection-complete fan-out, the consumer's
  // own queue).
  public async publishReturnInspected(event: IRetailReturnInspectedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailReturnInspectedEvent>(
        ROUTING_KEYS.RETAIL_RETURN_INSPECTED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_RETURN_INSPECTED, event);
  }

  // `retail.return.rejected` rides the `RETAIL_MICROSERVICE` client onto `retail_queue`
  // (the producer's own queue) — a reserved surface today, no consumer.
  public async publishReturnRejected(event: IRetailReturnRejectedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailReturnRejectedEvent>(
        ROUTING_KEYS.RETAIL_RETURN_REJECTED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_RETURN_REJECTED, event);
  }

  // `retail.return.closed` rides the `RETAIL_MICROSERVICE` client onto `retail_queue` —
  // a reserved surface today (the later refund capability is the natural consumer).
  public async publishReturnClosed(event: IRetailReturnClosedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailReturnClosedEvent>(
        ROUTING_KEYS.RETAIL_RETURN_CLOSED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_RETURN_CLOSED, event);
  }
}
