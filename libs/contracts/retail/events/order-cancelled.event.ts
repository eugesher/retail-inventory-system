import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.order.cancelled` event, published by the retail
// microservice after an order is cancelled (the `Order` walks `pending`/`confirmed →
// cancelled`). Framework-free — a domain object is never serialized across services
// (ADR-011); the Cancel Order use case maps the cancelled order onto this interface
// before emitting.
//
// NOTE: this key was *retired* by ADR-028 with the old order model; it is
// **re-introduced fresh here** with a live producer (Cancel Order), not resurrected
// from any stub. Emitted onto `retail_queue` (the producer's own queue) as a reserved
// surface today (no consumer bound yet), so it is a best-effort post-commit emit
// (ADR-020).
//
// `paymentFlaggedForRefund` is the key signal a downstream consumer branches on: `true`
// means the cancelled order had a **captured** payment that is now flagged for a refund
// (a refund is owed — the later refund capability issues it), `false` means there was
// nothing captured (an authorized payment was voided, or there was no payment).
// `reason` is the optional human-supplied cancellation reason (`null` when omitted).
// `eventVersion` is pinned to `'v1'`; a breaking change ships `'v2'`. `occurredAt` and
// `cancelledAt` are ISO-8601 strings.
//
// It is now **dual-emitted** — onto `retail_queue` (the producer's own queue, where the
// auto-refund-from-cancel `OrderCancelledConsumer` reads it) AND onto `notification_events`
// (the notification service's queue, where a cancellation-confirmation consumer binds it).
// `customerEmail` / `customerLocale` carry the buyer's notification contact for that second
// consumer, resolved producer-side from the shared `customer` table (a raw-SQL reader, no
// gateway-entity import) so it has a recipient WITHOUT a per-delivery cross-service RPC
// (ADR-033 choice). The email is `null` for a tombstoned/missing customer; `customerLocale`
// is a placeholder shipped `null` today (locale deferred). Both optional — additive on the
// wire.
export interface IRetailOrderCancelledEvent extends ICorrelationPayload {
  orderId: number;
  customerEmail?: string | null;
  customerLocale?: string | null;
  cancelledAt: string;
  reason: string | null;
  paymentFlaggedForRefund: boolean;
  eventVersion: 'v1';
  occurredAt: string;
}
