import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IRetailCartCreatedEvent,
  IRetailCartLineAddedEvent,
  IRetailCartLineQuantityChangedEvent,
  IRetailCartLineRemovedEvent,
} from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  RisEventsMirrorPublisher,
  ROUTING_KEYS,
} from '@retail-inventory-system/messaging';

import { ICartEventsPublisherPort } from '../../application/ports';

@Injectable()
export class CartRabbitmqPublisher implements ICartEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
  ) {}

  public async publishCartCreated(event: IRetailCartCreatedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailCartCreatedEvent>(
        ROUTING_KEYS.RETAIL_CART_CREATED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_CART_CREATED, event);
  }

  public async publishCartLineAdded(event: IRetailCartLineAddedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailCartLineAddedEvent>(
        ROUTING_KEYS.RETAIL_CART_LINE_ADDED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_CART_LINE_ADDED, event);
  }

  public async publishCartLineRemoved(event: IRetailCartLineRemovedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailCartLineRemovedEvent>(
        ROUTING_KEYS.RETAIL_CART_LINE_REMOVED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_CART_LINE_REMOVED, event);
  }

  public async publishCartLineQuantityChanged(
    event: IRetailCartLineQuantityChangedEvent,
  ): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailCartLineQuantityChangedEvent>(
        ROUTING_KEYS.RETAIL_CART_LINE_QUANTITY_CHANGED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_CART_LINE_QUANTITY_CHANGED, event);
  }
}
