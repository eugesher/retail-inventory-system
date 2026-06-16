import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.fulfillment.shipped` event, published by the
// retail microservice after a shipment ships (the `Fulfillment` walks `pending →
// shipped`). Framework-free — a domain object is never serialized across services
// (ADR-011); the Ship use case maps the shipped aggregate onto this interface before
// emitting.
//
// It is the past-tense counterpart of the imperative `retail.fulfillment.ship`
// command (the `catalog.variant.create`/`.created` split, ADR-008). Emitted onto
// `notification_events` (the consumer's own queue — the producer-targets-consumer-queue
// pattern `retail.order.placed` uses, ADR-008/020), where the notification service binds
// a shipment-confirmation consumer for it, so it is a best-effort post-commit emit
// (ADR-020). The payload carries the shipment header: `orderId` / `fulfillmentId`
// identify the shipment, `trackingNumber` / `carrier` are the carrier metadata a
// confirmation needs (`carrier` may be null), and `shippedAt` is the ship timestamp.
// `eventVersion` is pinned to `'v1'`; a breaking change ships `'v2'`. `occurredAt` and
// `shippedAt` are ISO-8601 strings.
export interface IRetailFulfillmentShippedEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  trackingNumber: string;
  carrier: string | null;
  shippedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
