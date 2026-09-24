import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  ICatalogPriceChangedEvent,
  ICatalogPriceScheduledEvent,
} from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  RisEventsMirrorPublisher,
  ROUTING_KEYS,
} from '@retail-inventory-system/messaging';

import { IPricingEventsPublisherPort } from '../../application/ports';

@Injectable()
export class PricingRabbitmqPublisher implements IPricingEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE)
    private readonly catalogClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
  ) {}

  public async publishPriceChanged(event: ICatalogPriceChangedEvent): Promise<void> {
    await firstValueFrom(
      this.catalogClient.emit<void, ICatalogPriceChangedEvent>(
        ROUTING_KEYS.CATALOG_PRICE_CHANGED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.CATALOG_PRICE_CHANGED, event);
  }

  public async publishPriceScheduled(event: ICatalogPriceScheduledEvent): Promise<void> {
    await firstValueFrom(
      this.catalogClient.emit<void, ICatalogPriceScheduledEvent>(
        ROUTING_KEYS.CATALOG_PRICE_SCHEDULED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.CATALOG_PRICE_SCHEDULED, event);
  }
}
