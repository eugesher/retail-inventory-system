import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.fulfillment.created` event, published by the
// retail microservice after a shipment is planned (a `Fulfillment` is persisted).
// Framework-free — a domain object is never serialized across services (ADR-011); the
// Create use case maps the saved aggregate onto this interface before emitting.
//
// It is the past-tense counterpart of the imperative `retail.fulfillment.create`
// command (the `catalog.variant.create`/`.created` split, ADR-008). Emitted onto
// `retail_queue` (the producer's own queue) as a reserved surface — no consumer is
// bound yet, so it is a best-effort post-commit emit (ADR-020). The payload is a thin
// header: `orderId` / `fulfillmentId` identify the shipment, `stockLocationId` names
// where it ships from, and `lineQuantities` summarizes which `OrderLine` quantities
// it carries; a consumer that needs more reads the fulfillment back. `eventVersion` is
// pinned to `'v1'`; a breaking change ships `'v2'`. `occurredAt` is an ISO-8601 string.
export interface IRetailFulfillmentCreatedEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  stockLocationId: string;
  lineQuantities: { orderLineId: number; quantity: number }[];
  eventVersion: 'v1';
  occurredAt: string;
}
