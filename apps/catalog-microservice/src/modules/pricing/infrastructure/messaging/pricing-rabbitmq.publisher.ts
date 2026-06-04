import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  ICatalogPriceChangedEvent,
  ICatalogPriceScheduledEvent,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IPricingEventsPublisherPort } from '../../application/ports';

// The only place in the pricing module allowed to hold a `ClientProxy` (ADR-009 /
// ADR-020). The use case has already built the versioned wire event from the
// persisted `Price`; this adapter just emits it onto `catalog_queue` — pricing
// colocates with catalog and shares its queue (ADR-026) — and waits for the
// broker ack. No consumer is bound yet; emitting to a queue with no matching
// handler is the same reserved-surface pattern the catalog events follow today.
@Injectable()
export class PricingRabbitmqPublisher implements IPricingEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE)
    private readonly catalogClient: ClientProxy,
  ) {}

  public async publishPriceChanged(event: ICatalogPriceChangedEvent): Promise<void> {
    // `ClientProxy.emit()` is a cold Observable; `firstValueFrom` materializes it
    // and waits for the broker ack so callers depend on a plain Promise.
    await firstValueFrom(
      this.catalogClient.emit<void, ICatalogPriceChangedEvent>(
        ROUTING_KEYS.CATALOG_PRICE_CHANGED,
        event,
      ),
    );
  }

  public async publishPriceScheduled(event: ICatalogPriceScheduledEvent): Promise<void> {
    await firstValueFrom(
      this.catalogClient.emit<void, ICatalogPriceScheduledEvent>(
        ROUTING_KEYS.CATALOG_PRICE_SCHEDULED,
        event,
      ),
    );
  }
}
