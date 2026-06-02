import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { ICatalogVariantCreatedEvent } from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { ICatalogEventsPublisherPort } from '../../application/ports';

// The only place in the catalog service allowed to hold a `ClientProxy`
// (ADR-009 / ADR-020). The use case has already built the versioned wire event;
// this adapter just emits it onto `catalog_queue` and waits for the broker ack.
// No consumer is bound yet — emitting to a queue with no matching handler is the
// same reserved-surface pattern `retail.order.confirmed` follows today.
@Injectable()
export class CatalogRabbitmqPublisher implements ICatalogEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE)
    private readonly catalogClient: ClientProxy,
  ) {}

  public async publishVariantCreated(event: ICatalogVariantCreatedEvent): Promise<void> {
    // `ClientProxy.emit()` is a cold Observable; `firstValueFrom` materializes
    // it and waits for the broker ack so callers depend on a plain Promise.
    await firstValueFrom(
      this.catalogClient.emit<void, ICatalogVariantCreatedEvent>(
        ROUTING_KEYS.CATALOG_VARIANT_CREATED,
        event,
      ),
    );
  }
}
