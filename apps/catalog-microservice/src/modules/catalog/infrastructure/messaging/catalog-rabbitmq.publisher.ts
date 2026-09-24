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
