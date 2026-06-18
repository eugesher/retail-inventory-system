import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock.committed` event, published by the
// inventory microservice when a Commit Sale ships an order's allocated stock at
// fulfillment time (ADR-031). Framework-free — a `DomainEvent` subclass is never
// serialized across services (ADR-011); the Commit Sale use case maps the
// in-process `StockCommittedEvent` to this interface before emitting.
//
// A reserved surface today: emitted onto `inventory_queue` (the inventory
// service's own queue) with no cross-service consumer bound yet — the intended
// consumer is a future event-store / audit capability (the
// `inventory.stock.{reserved,allocated,released}` precedent). `quantity` is the
// shipped quantity for the line; `fulfillmentId` is the shipment that triggered
// the commit (the idempotency anchor). `eventVersion` is pinned to `'v1'`;
// `occurredAt` is ISO-8601.
export interface IInventoryStockCommittedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  orderId: number;
  fulfillmentId: string;
  eventVersion: 'v1';
  occurredAt: string;
}
