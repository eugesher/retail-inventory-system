import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { IInventoryStockLowEvent } from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { StockLowEvent, StockReservedEvent } from '../../domain';
import { IStockEventsPublisherPort } from '../../application/ports';

@Injectable()
export class StockRabbitmqPublisher implements IStockEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
  ) {}

  public async publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void> {
    const wire: IInventoryStockLowEvent = {
      productId: event.aggregateId,
      storageId: event.storageId,
      quantity: event.quantity,
      threshold: event.threshold,
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    // `firstValueFrom` materializes the cold Observable from `emit()` and
    // waits for the broker ack so application code awaits a plain Promise.
    await firstValueFrom(
      this.notificationClient.emit<void, IInventoryStockLowEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_LOW,
        wire,
      ),
    );
  }

  public publishStockReserved(event: StockReservedEvent, correlationId?: string): Promise<void> {
    // Intentional no-op rather than a `not implemented` throw — no
    // cross-service consumer today, but the port stays callable so emit
    // sites do not have to guard the call.
    void event;
    void correlationId;
    return Promise.resolve();
  }
}
