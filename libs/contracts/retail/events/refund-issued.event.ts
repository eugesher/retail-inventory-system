import { ICorrelationPayload } from '../../microservices';

// `retail.refund.issued` — emitted onto `notification_events`, where the refund-confirmation
// consumer binds it (ADR-008/020). Best-effort post-commit.
//
// `amountMinor` is **this refund's** amount, not the order's running total. A partial refund is
// legal, and a second one can follow, so a consumer summing these gets the total refunded while
// any single event tells it only what moved this time.
//
// **The refund has no `customerId` of its own** — a refund belongs to a payment, which belongs to
// an order, which belongs to a buyer. `customerEmail` is therefore resolved producer-side by
// walking to the *order's* customer, so the consumer needs no per-delivery RPC (ADR-033). It is
// `null` for a tombstoned customer, and `customerLocale` always ships `null` — nothing in this
// system resolves a locale.
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
