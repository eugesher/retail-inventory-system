import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IInventoryStockAdjustedEvent,
  IInventoryStockLevelInitializedEvent,
  IInventoryStockLowEvent,
  IInventoryStockReceivedEvent,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  StockAdjustedEvent,
  StockLevelInitializedEvent,
  StockLowEvent,
  StockReceivedEvent,
  StockReservedEvent,
} from '../../domain';
import { IStockEventsPublisherPort } from '../../application/ports';

// The only place in the inventory service allowed to hold a `ClientProxy`
// (ADR-009 / ADR-020). It holds two clients because the inventory service emits
// onto two different consumer queues: `inventory.stock.low` lands on
// `notification_events` (the notification service's queue), while the
// `inventory.stock.{received,adjusted}` + `inventory.stock-level.initialized`
// events land on `inventory_queue` (the service's own queue, reserved surfaces
// with no cross-service consumer yet). Each is the producer-targets-consumer-queue
// pattern — the destination queue is fixed by which client token the emit goes
// through (ADR-008 / ADR-020).
@Injectable()
export class StockRabbitmqPublisher implements IStockEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  public async publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void> {
    const wire: IInventoryStockLowEvent = {
      variantId: event.aggregateId,
      stockLocationId: event.stockLocationId,
      quantity: event.quantity,
      threshold: event.threshold,
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    // `firstValueFrom` materializes the cold Observable from `emit()` and
    // waits for the broker ack so application code awaits a plain Promise.
    // Emitted via the notification client → lands on `notification_events`.
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

  public async publishStockReceived(
    event: StockReceivedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IInventoryStockReceivedEvent = {
      variantId: event.aggregateId,
      stockLocationId: event.stockLocationId,
      quantityDelta: event.quantityDelta,
      newOnHand: event.newOnHand,
      actorId: event.actorId,
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    // Emitted via the inventory client → lands on `inventory_queue` (reserved
    // surface, no handler bound yet).
    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockReceivedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_RECEIVED,
        wire,
      ),
    );
  }

  public async publishStockAdjusted(
    event: StockAdjustedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IInventoryStockAdjustedEvent = {
      variantId: event.aggregateId,
      stockLocationId: event.stockLocationId,
      quantityDelta: event.quantityDelta,
      reasonCode: event.reasonCode,
      newOnHand: event.newOnHand,
      actorId: event.actorId,
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    // Emitted via the inventory client → lands on `inventory_queue` (reserved
    // surface, no handler bound yet).
    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockAdjustedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_ADJUSTED,
        wire,
      ),
    );
  }

  public async publishStockLevelInitialized(
    event: StockLevelInitializedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IInventoryStockLevelInitializedEvent = {
      variantId: event.aggregateId,
      stockLocationId: event.stockLocationId,
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    // Emitted via the inventory client → lands on `inventory_queue`. No handler
    // is bound to this pattern yet (reserved surface); the broker holds it for a
    // future consumer (e.g. an audit capability).
    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockLevelInitializedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED,
        wire,
      ),
    );
  }
}
