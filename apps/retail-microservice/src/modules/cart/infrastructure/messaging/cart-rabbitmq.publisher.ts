import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IRetailCartCreatedEvent,
  IRetailCartLineAddedEvent,
  IRetailCartLineQuantityChangedEvent,
  IRetailCartLineRemovedEvent,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { ICartEventsPublisherPort } from '../../application/ports';

// The cart context's event publisher and the second of the module's two
// `ClientProxy` holders (ADR-009 / ADR-020). The use case has already built the
// versioned wire event; this adapter just emits it and waits for the broker ack.
//
// All four `retail.cart.*` events are emitted through the `RETAIL_MICROSERVICE`
// client, so they land on `retail_queue` — the producer's own queue. They are
// reserved surfaces: no `@EventPattern` consumer is bound to them yet (the same
// pattern the `inventory.stock.{received,adjusted}` reserved events follow). The
// broker holds them for a future consumer (e.g. an analytics or cart-recovery
// capability).
@Injectable()
export class CartRabbitmqPublisher implements ICartEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailClient: ClientProxy,
  ) {}

  public async publishCartCreated(event: IRetailCartCreatedEvent): Promise<void> {
    // `ClientProxy.emit()` is a cold Observable; `firstValueFrom` materializes it
    // and waits for the broker ack so callers depend on a plain Promise.
    await firstValueFrom(
      this.retailClient.emit<void, IRetailCartCreatedEvent>(
        ROUTING_KEYS.RETAIL_CART_CREATED,
        event,
      ),
    );
  }

  public async publishCartLineAdded(event: IRetailCartLineAddedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailCartLineAddedEvent>(
        ROUTING_KEYS.RETAIL_CART_LINE_ADDED,
        event,
      ),
    );
  }

  public async publishCartLineRemoved(event: IRetailCartLineRemovedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailCartLineRemovedEvent>(
        ROUTING_KEYS.RETAIL_CART_LINE_REMOVED,
        event,
      ),
    );
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
  }
}
