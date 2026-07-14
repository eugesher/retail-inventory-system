import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock.adjusted` event, published by the
// inventory microservice when an Adjust Stock operation applies a signed delta to
// a variant's on-hand quantity at a stock location (ADR-027). Framework-free — a
// `DomainEvent` subclass is never serialized across services (ADR-011); the
// Adjust use case maps the in-process `StockAdjustedEvent` to this interface
// before emitting.
//
// A reserved surface: emitted onto `inventory_queue` with no business consumer (README §2).
//
// `reasonCode` is mandatory. It rides the wire (and the logs) as well as the `adjustment`
// `StockMovement` row the Adjust use case appends in the same transaction (ADR-030), so a
// consumer of this event does not need to join the ledger to know why the delta happened.
// `eventVersion` is pinned to `'v1'`; a breaking payload change ships as `'v2'`.
export interface IInventoryStockAdjustedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantityDelta: number;
  reasonCode: string;
  newOnHand: number;
  actorId?: string;
  eventVersion: 'v1';
  occurredAt: string;
}
