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
  // Application code awaits a plain Promise; the adapter materializes the
  // cold Observable from `ClientProxy.emit()` and waits for the broker ack.
  // `inventory.stock.low` lands on `notification_events` (the notification
  // service's queue); everything else here is a reserved surface on the
  // inventory service's own `inventory_queue` (no cross-service consumer yet).
  publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void>;
  // Emitted by the Receive Stock operation onto `inventory_queue`.
  publishStockReceived(event: StockReceivedEvent, correlationId?: string): Promise<void>;
  // Emitted by the Adjust Stock operation onto `inventory_queue`.
  publishStockAdjusted(event: StockAdjustedEvent, correlationId?: string): Promise<void>;
  // Emitted onto `inventory_queue` when the auto-init consumer creates a
  // brand-new `stock_level` row — a reserved surface, no cross-service consumer
  // yet.
  publishStockLevelInitialized(
    event: StockLevelInitializedEvent,
    correlationId?: string,
  ): Promise<void>;
  // Emitted by the Reserve operation onto `inventory_queue` (reserved surface).
  publishStockReserved(event: StockReservedEvent, correlationId?: string): Promise<void>;
  // Emitted by the Allocate operation onto `inventory_queue` (reserved surface),
  // one per allocated line.
  publishStockAllocated(event: StockAllocatedEvent, correlationId?: string): Promise<void>;
  // Emitted by the Release + Cancel-Allocation operations onto `inventory_queue`
  // (reserved surface).
  publishStockReleased(event: StockReleasedEvent, correlationId?: string): Promise<void>;
  // Emitted by the Commit Sale operation onto `inventory_queue` (reserved surface),
  // one per shipped line.
  publishStockCommitted(event: StockCommittedEvent, correlationId?: string): Promise<void>;
  // Emitted by the Restock from Return operation onto `inventory_queue` (reserved
  // surface), one per restocked line. The typed alias for the positive `return`
  // movement, exposed as its own key for downstream filtering convenience (ADR-032).
  publishStockReturned(event: StockReturnedEvent, correlationId?: string): Promise<void>;
  // Emitted for EVERY ledger insert (high-volume). It takes the domain
  // `StockMovement` record directly — a deliberate divergence from the other
  // methods (which take a `DomainEvent`): a dedicated wrapper event class would
  // only duplicate the row's fields, so the publisher maps the record straight to
  // the wire `IInventoryStockMovementRecordedEvent`. Reserved surface on
  // `inventory_queue`.
  publishStockMovementRecorded(movement: StockMovement, correlationId?: string): Promise<void>;
}
