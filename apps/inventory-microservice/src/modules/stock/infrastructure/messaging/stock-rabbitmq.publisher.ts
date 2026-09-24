import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IInventoryStockAdjustedEvent,
  IInventoryStockAllocatedEvent,
  IInventoryStockCommittedEvent,
  IInventoryStockLevelInitializedEvent,
  IInventoryStockLowEvent,
  IInventoryStockMovementRecordedEvent,
  IInventoryStockReceivedEvent,
  IInventoryStockReleasedEvent,
  IInventoryStockReservedEvent,
  IInventoryStockReturnedEvent,
} from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  RisEventsMirrorPublisher,
  ROUTING_KEYS,
} from '@retail-inventory-system/messaging';

import {
  StockAdjustedEvent,
  StockAllocatedEvent,
  StockCommittedEvent,
  StockLevelInitializedEvent,
  StockLowEvent,
  StockMovement,
  StockReceivedEvent,
  StockReleasedEvent,
  StockReservedEvent,
  StockReturnedEvent,
} from '../../domain';
import { IStockEventsPublisherPort } from '../../application/ports';

@Injectable()
export class StockRabbitmqPublisher implements IStockEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
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

    await firstValueFrom(
      this.notificationClient.emit<void, IInventoryStockLowEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_LOW,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_LOW, wire);
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

    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockReceivedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_RECEIVED,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_RECEIVED, wire);
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

    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockAdjustedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_ADJUSTED,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_ADJUSTED, wire);
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

    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockLevelInitializedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED, wire);
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

    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockReservedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_RESERVED,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_RESERVED, wire);
  }

  public async publishStockAllocated(
    event: StockAllocatedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IInventoryStockAllocatedEvent = {
      variantId: event.aggregateId,
      stockLocationId: event.stockLocationId,
      quantity: event.quantity,
      orderId: event.orderId,
      reservationId: event.reservationId,
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockAllocatedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_ALLOCATED,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_ALLOCATED, wire);
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

    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockReleasedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_RELEASED,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_RELEASED, wire);
  }

  public async publishStockCommitted(
    event: StockCommittedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IInventoryStockCommittedEvent = {
      variantId: event.aggregateId,
      stockLocationId: event.stockLocationId,
      quantity: event.quantity,
      orderId: event.orderId,
      fulfillmentId: event.fulfillmentId,
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockCommittedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_COMMITTED,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_COMMITTED, wire);
  }

  public async publishStockReturned(
    event: StockReturnedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IInventoryStockReturnedEvent = {
      variantId: event.aggregateId,
      stockLocationId: event.stockLocationId,
      quantity: event.quantity,
      returnRequestId: event.returnRequestId,
      returnLineId: event.returnLineId,
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockReturnedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_RETURNED,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_RETURNED, wire);
  }

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

    await firstValueFrom(
      this.inventoryClient.emit<void, IInventoryStockMovementRecordedEvent>(
        ROUTING_KEYS.INVENTORY_STOCK_MOVEMENT_RECORDED,
        wire,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.INVENTORY_STOCK_MOVEMENT_RECORDED, wire);
  }
}
