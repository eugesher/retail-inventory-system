import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock.returned` event, published by the
// inventory microservice when a Restock from Return puts a return request's
// `restock`-disposition stock back on-hand (ADR-032). Framework-free — a
// `DomainEvent` subclass is never serialized across services (ADR-011); the
// Restock use case maps the in-process `StockReturnedEvent` to this interface
// before emitting.
//
// It is the typed alias for the positive `return`-type movement, exposed as its
// own routing key so a downstream consumer can filter returned-stock events
// without scanning every `inventory.stock-movement.recorded`. A reserved surface
// today: emitted onto `inventory_queue` (the inventory service's own queue) with
// no cross-service consumer bound yet — the intended consumer is a future
// event-store / audit capability (the `inventory.stock.{reserved,allocated,
// released,committed}` precedent). `quantity` is the restocked quantity for the
// line; `returnRequestId` is the RMA whose inspection triggered the restock (the
// idempotency anchor), `returnLineId` the specific line. `eventVersion` is pinned
// to `'v1'`; `occurredAt` is ISO-8601.
export interface IInventoryStockReturnedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  returnRequestId: number;
  returnLineId: number;
  eventVersion: 'v1';
  occurredAt: string;
}
