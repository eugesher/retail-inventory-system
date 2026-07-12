import { ICorrelationPayload } from '../../microservices';

// `retail.fulfillment.shipped` — emitted onto `notification_events`, where the notification
// service's shipment-confirmation consumer binds it (an event goes to the queue of whoever consumes
// it, ADR-008/020). The emit is best-effort post-commit: the shipment is already durable, so a
// broker failure loses the confirmation, never the shipment.
//
// **`customerEmail` is carried ON the event, resolved producer-side from the shared `customer`
// table.** That is deliberate (ADR-033): it spares the consumer a cross-service RPC per delivery.
// It is `null` for a tombstoned customer, and `customerLocale` always ships `null` — nothing in
// this system resolves a locale.
//
// `trackingNumber` is non-nullable here because a fulfillment **cannot reach `shipped` without
// one** — `Fulfillment.ship` rejects a blank. The carrier is not held to the same standard.
export interface IRetailFulfillmentShippedEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  customerEmail?: string | null;
  customerLocale?: string | null;
  trackingNumber: string;
  carrier: string | null;
  shippedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
