import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.fulfillment.delivered` event, published by the
// retail microservice after a shipment is marked delivered (the `Fulfillment` walks
// `shipped → delivered`). Framework-free — a domain object is never serialized across
// services (ADR-011); the Mark Delivered use case maps the delivered aggregate onto
// this interface before emitting.
//
// It is the past-tense counterpart of the imperative `retail.fulfillment.deliver`
// command (the `catalog.variant.create`/`.created` split, ADR-008). Emitted onto
// `retail_queue` (the producer's own queue) as a reserved surface today (no consumer
// bound yet, like `retail.fulfillment.created`), so it is a best-effort post-commit
// emit (ADR-020). `orderId` / `fulfillmentId` identify the shipment; `deliveredAt` is
// the delivery timestamp. `eventVersion` is pinned to `'v1'`; a breaking change ships
// `'v2'`. `occurredAt` and `deliveredAt` are ISO-8601 strings.
export interface IRetailFulfillmentDeliveredEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  deliveredAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
