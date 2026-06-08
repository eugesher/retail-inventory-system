import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock.adjusted` event, published by the
// inventory microservice when an Adjust Stock operation applies a signed delta to
// a variant's on-hand quantity at a stock location (ADR-027). Framework-free — a
// `DomainEvent` subclass is never serialized across services (ADR-011); the
// Adjust use case maps the in-process `StockAdjustedEvent` to this interface
// before emitting.
//
// A reserved surface today: it is emitted onto `inventory_queue` (the inventory
// service's own queue) with no cross-service consumer bound yet. `quantityDelta`
// is the signed adjustment (positive or negative); `reasonCode` is the mandatory
// audit reason carried on the wire (and in logs) until a `StockMovement` audit
// log lands with a later capability — no movement row is written today.
// `newOnHand` is the post-commit running total. `actorId` is the staff user who
// performed the adjustment (optional — a direct RMQ caller may omit it).
// `eventVersion` is pinned to `'v1'`; a breaking payload change ships as `'v2'`.
// `occurredAt` is an ISO-8601 string.
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
