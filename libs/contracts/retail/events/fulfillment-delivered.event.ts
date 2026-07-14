import { ICorrelationPayload } from '../../microservices';

// `retail.fulfillment.delivered` — emitted onto `notification_events`, where the delivery-
// confirmation consumer binds it (an event goes to the queue of whoever consumes it, ADR-008/020).
// Best-effort post-commit.
//
// **It fires per shipment, not per order.** An order with split shipments raises one of these for
// each; the order itself only reaches `delivered` once every non-cancelled fulfillment has.
//
// `customerEmail` is carried on the event, resolved producer-side from the shared `customer` table
// so the consumer needs no per-delivery RPC (ADR-033). It is `null` for a tombstoned customer, and
// `customerLocale` always ships `null` — nothing in this system resolves a locale.
export interface IRetailFulfillmentDeliveredEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  customerEmail?: string | null;
  customerLocale?: string | null;
  deliveredAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
