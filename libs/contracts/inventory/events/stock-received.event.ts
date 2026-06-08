import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock.received` event, published by the
// inventory microservice when a Receive Stock operation raises a variant's
// on-hand quantity at a stock location (ADR-027). Framework-free — a
// `DomainEvent` subclass is never serialized across services (ADR-011); the
// Receive use case maps the in-process `StockReceivedEvent` to this interface
// before emitting.
//
// A reserved surface today: it is emitted onto `inventory_queue` (the inventory
// service's own queue) with no cross-service consumer bound yet — the same
// reserved-surface pattern `inventory.stock-level.initialized` and the `catalog.*`
// events follow. `quantityDelta` is the positive amount received; `newOnHand` is
// the post-commit running total. `actorId` is the staff user who performed the
// receive (optional — a direct RMQ caller may omit it). `eventVersion` is pinned
// to `'v1'`; a breaking payload change ships as `'v2'`. `occurredAt` is an
// ISO-8601 string.
export interface IInventoryStockReceivedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantityDelta: number;
  newOnHand: number;
  actorId?: string;
  eventVersion: 'v1';
  occurredAt: string;
}
