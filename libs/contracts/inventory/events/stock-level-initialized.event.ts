import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock-level.initialized` event, published
// by the inventory microservice when its catalog-events consumer creates the
// first `stock_level` row for a newly seen variant (zeroed, at the default
// warehouse). Framework-free — a `DomainEvent` subclass is never serialized
// across services (ADR-011); the use case maps the in-process
// `StockLevelInitializedEvent` to this interface before emitting.
//
// A reserved surface today: it is emitted onto `inventory_queue` (the inventory
// service's own queue) with no cross-service consumer bound yet — the same
// reserved-surface pattern the `catalog.*` events follow. `eventVersion` is
// pinned to `'v1'`; a breaking payload change ships as `'v2'`. `occurredAt` is an
// ISO-8601 string.
export interface IInventoryStockLevelInitializedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  eventVersion: 'v1';
  occurredAt: string;
}
