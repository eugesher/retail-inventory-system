import { ICorrelationPayload } from '../../microservices';
import { ReservationReleaseReason } from '../reservation';

// Wire-format shape for the `inventory.stock.released` event, published by the
// inventory microservice when a Release returns held units to `available`
// (ADR-030). Framework-free — a `DomainEvent` subclass is never serialized across
// services (ADR-011); the Release use case maps the in-process `StockReleasedEvent`
// to this interface before emitting.
//
// A reserved surface: emitted onto `inventory_queue` with no *business* consumer —
// it is captured by the event-store firehose, which binds `#` on the `ris.events`
// mirror (docs/adr/035-event-store-firehose-topic-exchange.md). `reservationId` /
// `cartId` are **nullable** so the order-cancel emitter (which releases by order,
// not by a single hold) can omit them. `reason` is why the hold was released.
// `eventVersion` is pinned to `'v1'`; `occurredAt` is ISO-8601.
export interface IInventoryStockReleasedEvent extends ICorrelationPayload {
  reservationId: string | null;
  variantId: number;
  stockLocationId: string;
  quantity: number;
  cartId: string | null;
  reason: ReservationReleaseReason;
  eventVersion: 'v1';
  occurredAt: string;
}
