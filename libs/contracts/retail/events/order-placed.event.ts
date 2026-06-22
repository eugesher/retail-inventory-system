import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.order.placed` event, published by the retail
// microservice after a cart is converted to an immutable `Order` and its payment
// is authorized. Framework-free — a domain object is never serialized across
// services (ADR-011); the place use case maps the persisted order onto this
// interface before emitting.
//
// It is emitted onto `notification_events` so a future order-confirmation consumer
// can fan it out (the notification re-point capability binds the consumer; until
// then it is a best-effort post-commit emit, ADR-020). The payload is intentionally
// a thin header — `orderId` / `orderNumber` identify the order, the money +
// `lineCount` summarize it; a consumer that needs the full line detail reads the
// order back. `customerId` is the gateway customer UUID or `null` (a tombstoned
// order). `eventVersion` is pinned to `'v1'`; a breaking change ships `'v2'`.
// `occurredAt` is an ISO-8601 string.
//
// `customerEmail` / `customerLocale` are the buyer's notification contact, resolved
// producer-side from the shared `customer` table (a raw-SQL reader, no gateway-entity
// import) so the notification consumer has a recipient WITHOUT a per-delivery
// cross-service RPC (ADR-033 records this "carry the email on the event" choice). The
// email is `null` for a tombstoned/missing customer; `customerLocale` is a placeholder
// shipped `null` today (locale resolution is deferred). Both are optional so the field
// is additive on the wire — older consumers ignore it.
export interface IRetailOrderPlacedEvent extends ICorrelationPayload {
  orderId: number;
  orderNumber: string;
  customerId: string | null;
  customerEmail?: string | null;
  customerLocale?: string | null;
  grandTotalMinor: number;
  currency: string;
  lineCount: number;
  eventVersion: 'v1';
  occurredAt: string;
}
