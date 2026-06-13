import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IInventoryStockAdjustedEvent,
  IInventoryStockLevelInitializedEvent,
  IInventoryStockLowEvent,
  IInventoryStockMovementRecordedEvent,
  IInventoryStockReceivedEvent,
  IInventoryStockReleasedEvent,
  IInventoryStockReservedEvent,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  StockAdjustedEvent,
  StockLevelInitializedEvent,
  StockLowEvent,
  StockMovement,
  StockReceivedEvent,
  StockReleasedEvent,
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

  public async publishStockReserved(
    event: StockReservedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IInventoryStockReservedEvent = {
      reservationId: event.reservationId,
      variantId: event.aggregateId,
      stockLocationId: event.stockLocationId,
      quantity: event.quantity,
      cartId: event.cartId,
      expiresAt: event.expiresAt.toISOString(),
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    // Reserved surface on `inventory_queue` (no handler bound yet).
    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockReservedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_RESERVED,
        wire,
      ),
    );
  }

  public async publishStockReleased(
    event: StockReleasedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IInventoryStockReleasedEvent = {
      reservationId: event.reservationId,
      variantId: event.aggregateId,
      stockLocationId: event.stockLocationId,
      quantity: event.quantity,
      cartId: event.cartId,
      reason: event.reason,
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    // Reserved surface on `inventory_queue` (no handler bound yet).
    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockReleasedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_RELEASED,
        wire,
      ),
    );
  }

  // Maps the domain `StockMovement` record straight to the wire event (no wrapper
  // event class — see the port comment). The record is always the just-appended
  // one, so its DB-assigned `id` is concrete; a null id here is an internal bug
  // (calling publish before append), surfaced as a plain `Error` the best-effort
  // caller warn-swallows.
  public async publishStockMovementRecorded(
    movement: StockMovement,
    correlationId?: string,
  ): Promise<void> {
    if (movement.id === null) {
      throw new Error('publishStockMovementRecorded: movement id is null (not yet appended)');
    }

    const wire: IInventoryStockMovementRecordedEvent = {
      movementId: movement.id,
      variantId: movement.variantId,
      stockLocationId: movement.stockLocationId,
      type: movement.type,
      quantity: movement.quantity,
      reasonCode: movement.reasonCode,
      referenceType: movement.referenceType,
      referenceId: movement.referenceId,
      actorId: movement.actorId,
      eventVersion: 'v1',
      occurredAt: movement.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    // Reserved surface on `inventory_queue` (no handler bound yet).
    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockMovementRecordedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_MOVEMENT_RECORDED,
        wire,
      ),
    );
  }
}
