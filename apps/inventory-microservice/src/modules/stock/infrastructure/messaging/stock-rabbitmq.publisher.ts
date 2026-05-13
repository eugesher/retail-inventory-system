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

    // `ClientProxy.emit()` returns a cold Observable; `firstValueFrom`
    // materializes it and waits for the broker ack so application code can
    // await a plain Promise (see _carryover-07 §5 #3).
    await firstValueFrom(
      this.notificationClient.emit<void, IInventoryStockLowEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_LOW,
        wire,
      ),
    );
  }

  public publishStockReserved(event: StockReservedEvent, correlationId?: string): Promise<void> {
    // No cross-service consumer for `stock.reserved` today; the port surface
    // exists so the publisher binding is in place when one is added (e.g.
    // an analytics service that wants per-line reservation telemetry).
    // Intentional no-op rather than a `not implemented` throw — call sites
    // would otherwise have to guard every emit.
    void event;
    void correlationId;
    return Promise.resolve();
  }
}
