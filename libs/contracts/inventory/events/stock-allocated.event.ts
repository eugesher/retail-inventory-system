import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock.allocated` event, published by the
// inventory microservice when an Allocate commits a hold into a firm allocation
// for an order (ADR-030 §4). Framework-free — a `DomainEvent` subclass is never
// serialized across services (ADR-011); the Allocate use case maps the in-process
// `StockAllocatedEvent` to this interface before emitting.
//
// A reserved surface: emitted onto `inventory_queue` (the inventory service's own
// queue) with no *business* consumer — it is captured by the event-store firehose,
// which binds `#` on the `ris.events` mirror
// (docs/adr/035-event-store-firehose-topic-exchange.md), the
// `inventory.stock.{reserved,released}` precedent. `quantity` is the allocated
// quantity for the line; `reservationId` is **null** on the direct-allocation
// fallback path (no prior hold). `eventVersion` is pinned to `'v1'`; `occurredAt`
// is ISO-8601.
export interface IInventoryStockAllocatedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  orderId: number;
  reservationId: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
