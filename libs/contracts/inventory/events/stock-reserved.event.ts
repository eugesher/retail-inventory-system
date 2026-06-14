import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock.reserved` event, published by the
// inventory microservice when a Reserve operation holds stock for a cart
// (ADR-030). Framework-free — a `DomainEvent` subclass is never serialized across
// services (ADR-011); the Reserve use case maps the in-process `StockReservedEvent`
// to this interface before emitting.
//
// A reserved surface today: emitted onto `inventory_queue` (the inventory
// service's own queue) with no cross-service consumer bound yet — the intended
// consumer is a future event-store capability (the `inventory.stock.{received,
// adjusted}` precedent). `quantity` is the absolute held quantity for the triple;
// `expiresAt` is the ISO-8601 instant the hold lapses. `eventVersion` is pinned to
// `'v1'`; a breaking payload change ships as `'v2'`. `occurredAt` is ISO-8601.
export interface IInventoryStockReservedEvent extends ICorrelationPayload {
  reservationId: string;
  variantId: number;
  stockLocationId: string;
  quantity: number;
  cartId: string;
  expiresAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
