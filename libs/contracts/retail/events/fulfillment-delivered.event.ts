import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.fulfillment.delivered` event, published by the
// retail microservice after a shipment is marked delivered (the `Fulfillment` walks
// `shipped → delivered`). Framework-free — a domain object is never serialized across
// services (ADR-011); the Mark Delivered use case maps the delivered aggregate onto
// this interface before emitting.
//
// It is the past-tense counterpart of the imperative `retail.fulfillment.deliver`
// command (the `catalog.variant.create`/`.created` split, ADR-008). Emitted onto
// `notification_events` (the consumer's own queue — the producer-targets-consumer-queue
// pattern `retail.order.placed` uses, ADR-008/020), where the notification service binds
// a delivery-confirmation consumer for it, so it is a best-effort post-commit
// emit (ADR-020). `orderId` / `fulfillmentId` identify the shipment; `deliveredAt` is
// the delivery timestamp. `eventVersion` is pinned to `'v1'`; a breaking change ships
// `'v2'`. `occurredAt` and `deliveredAt` are ISO-8601 strings.
//
// `customerEmail` / `customerLocale` carry the buyer's notification contact, resolved
// producer-side from the shared `customer` table (a raw-SQL reader, no gateway-entity
// import) so the delivery-confirmation consumer has a recipient WITHOUT a per-delivery
// cross-service RPC (ADR-033 choice). The email is `null` for a tombstoned/missing
// customer; `customerLocale` is a placeholder shipped `null` today (locale deferred).
// Both optional — the field is additive on the wire.
export interface IRetailFulfillmentDeliveredEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  customerEmail?: string | null;
  customerLocale?: string | null;
  deliveredAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
