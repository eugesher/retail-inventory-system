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

export const STOCK_EVENTS_PUBLISHER = Symbol('STOCK_EVENTS_PUBLISHER');

export interface IStockEventsPublisherPort {
  publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void>;
  publishStockReceived(event: StockReceivedEvent, correlationId?: string): Promise<void>;
  publishStockAdjusted(event: StockAdjustedEvent, correlationId?: string): Promise<void>;
  publishStockLevelInitialized(
    event: StockLevelInitializedEvent,
    correlationId?: string,
  ): Promise<void>;
  publishStockReserved(event: StockReservedEvent, correlationId?: string): Promise<void>;
  publishStockAllocated(event: StockAllocatedEvent, correlationId?: string): Promise<void>;
  publishStockReleased(event: StockReleasedEvent, correlationId?: string): Promise<void>;
  publishStockCommitted(event: StockCommittedEvent, correlationId?: string): Promise<void>;
  publishStockReturned(event: StockReturnedEvent, correlationId?: string): Promise<void>;
  publishStockMovementRecorded(movement: StockMovement, correlationId?: string): Promise<void>;
}
