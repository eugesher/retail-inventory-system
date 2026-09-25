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

  public async publishReturnInspected(event: IRetailReturnInspectedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailReturnInspectedEvent>(
        ROUTING_KEYS.RETAIL_RETURN_INSPECTED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_RETURN_INSPECTED, event);
  }

  public async publishReturnRejected(event: IRetailReturnRejectedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailReturnRejectedEvent>(
        ROUTING_KEYS.RETAIL_RETURN_REJECTED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_RETURN_REJECTED, event);
  }

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
