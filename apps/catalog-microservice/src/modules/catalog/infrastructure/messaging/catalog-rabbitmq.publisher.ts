import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  ICatalogProductArchivedEvent,
  ICatalogProductPublishedEvent,
  ICatalogVariantCreatedEvent,
} from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  RisEventsMirrorPublisher,
  ROUTING_KEYS,
} from '@retail-inventory-system/messaging';

import { ICatalogEventsPublisherPort } from '../../application/ports';

// The only place in the catalog service allowed to hold a `ClientProxy`
// (ADR-009 / ADR-020). The use case has already built the versioned wire event;
// this adapter just emits it and waits for the broker ack.
//
// `catalog.variant.created` is emitted through the `INVENTORY_MICROSERVICE`
// client so it lands on `inventory_queue` — the inventory service's auto-init
// consumer subscribes there. This is the producer-targets-consumer-queue pattern
// (ADR-008 / ADR-020, default exchange only), the same one
// `inventory.stock.low → notification_events` already uses; it is not a new
// architectural decision and needs no topic/fanout exchange.
//
// `catalog.product.published` / `.archived` stay on `catalog_queue` as reserved
// surfaces — emitting to a queue with no matching handler is the same pattern
// `retail.order.confirmed` follows today.
//
// Every event is additionally **dual-published** (ADR-035): after the primary
// emit, the same routing key + wire is mirrored onto the `ris.events` topic
// exchange via the shared `RisEventsMirrorPublisher`, so the event-store firehose
// captures the catalog stream without re-binding the inventory auto-init consumer.
// The mirror is best-effort and non-throwing, ordered after the primary emit.
@Injectable()
export class CatalogRabbitmqPublisher implements ICatalogEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE)
    private readonly catalogClient: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
  ) {}

  public async publishVariantCreated(event: ICatalogVariantCreatedEvent): Promise<void> {
    // `ClientProxy.emit()` is a cold Observable; `firstValueFrom` materializes
    // it and waits for the broker ack so callers depend on a plain Promise.
    // Targets `inventory_queue` via the inventory client.
    await firstValueFrom(
      this.inventoryClient.emit<void, ICatalogVariantCreatedEvent>(
        ROUTING_KEYS.CATALOG_VARIANT_CREATED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.CATALOG_VARIANT_CREATED, event);
  }

  public async publishProductPublished(event: ICatalogProductPublishedEvent): Promise<void> {
    await firstValueFrom(
      this.catalogClient.emit<void, ICatalogProductPublishedEvent>(
        ROUTING_KEYS.CATALOG_PRODUCT_PUBLISHED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.CATALOG_PRODUCT_PUBLISHED, event);
  }

  public async publishProductArchived(event: ICatalogProductArchivedEvent): Promise<void> {
    await firstValueFrom(
      this.catalogClient.emit<void, ICatalogProductArchivedEvent>(
        ROUTING_KEYS.CATALOG_PRODUCT_ARCHIVED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.CATALOG_PRODUCT_ARCHIVED, event);
  }
}
