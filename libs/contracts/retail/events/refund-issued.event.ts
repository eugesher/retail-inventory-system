import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.refund.issued` event, published by the retail
// microservice when a refund issues successfully (the `Refund` walks `pending → issued`
// and the `Payment` accumulates `refunded_amount_minor`). Framework-free (ADR-011); the
// Issue Refund use case maps the persisted refund onto this interface before emitting.
//
// Emitted onto `notification_events` (the notification service's own queue, the
// producer-targets-consumer-queue pattern, ADR-008/020) so a refund-confirmation fan-out
// can consume it. `refundId` / `orderId` / `paymentId` identify the rows; `amountMinor`
// is this refund's amount in integer minor units (cents). `issuedAt` is the gateway's
// refund stamp (ISO-8601); `eventVersion` is pinned to `'v1'`; `occurredAt` is an
// ISO-8601 string.
//
// The refund event carries no `customerId` of its own, so `customerEmail` / `customerLocale`
// are resolved producer-side from the refund's **order** `customerId` against the shared
// `customer` table (a raw-SQL reader, no gateway-entity import) — giving the
// refund-confirmation consumer a recipient WITHOUT a per-delivery cross-service RPC (ADR-033
// choice), in place of the older `order:<orderId>` derived recipient. The email is `null` for
// a tombstoned/missing customer; `customerLocale` is a placeholder shipped `null` today
// (locale deferred). Both optional — additive on the wire.
export interface IRetailRefundIssuedEvent extends ICorrelationPayload {
  refundId: number;
  orderId: number;
  paymentId: number;
  customerEmail?: string | null;
  customerLocale?: string | null;
  amountMinor: number;
  currency: string;
  issuedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
