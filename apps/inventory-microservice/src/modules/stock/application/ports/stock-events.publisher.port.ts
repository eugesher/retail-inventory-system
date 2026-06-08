import { StockLevelInitializedEvent, StockLowEvent, StockReservedEvent } from '../../domain';

export const STOCK_EVENTS_PUBLISHER = Symbol('STOCK_EVENTS_PUBLISHER');

export interface IStockEventsPublisherPort {
  // Application code awaits a plain Promise; the adapter materializes the
  // cold Observable from `ClientProxy.emit()` and waits for the broker ack.
  publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void>;
  publishStockReserved(event: StockReservedEvent, correlationId?: string): Promise<void>;
  // Emitted onto `inventory_queue` (the service's own queue) when the auto-init
  // consumer creates a brand-new `stock_level` row — a reserved surface, no
  // cross-service consumer yet.
  publishStockLevelInitialized(
    event: StockLevelInitializedEvent,
    correlationId?: string,
  ): Promise<void>;
}
