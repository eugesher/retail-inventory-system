import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.refund.failed` event, published by the retail
// microservice when the payment gateway **declines** a refund (the `Refund` walks
// `pending → failed`, terminal; the `Payment` is left unchanged). Framework-free
// (ADR-011). Unreachable with the always-succeed fake gateway, but modeled so a real
// processor's decline has a home (the `ORDER_PAYMENT_NOT_APPROVED` precedent).
//
// Emitted onto `retail_queue` (the producer's own queue — a reserved surface today, no
// consumer), distinct from the buyer-facing `retail.refund.issued` on `notification_events`.
// Same identity + amount fields as the issued event plus a `failureReason` carrying the
// gateway's decline detail. `eventVersion` is pinned to `'v1'`; `occurredAt` is an
// ISO-8601 string.
export interface IRetailRefundFailedEvent extends ICorrelationPayload {
  refundId: number;
  orderId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  failureReason: string;
  eventVersion: 'v1';
  occurredAt: string;
}
