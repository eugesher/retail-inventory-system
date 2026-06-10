import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.payment.authorized` event, published by the
// retail microservice when authorize-on-place succeeds. Framework-free (ADR-011);
// the place use case maps the persisted payment onto this interface before
// emitting.
//
// A reserved surface today: it is emitted onto `retail_queue` (the producer's own
// queue) with no cross-service consumer bound yet — the same reserved-surface
// pattern the four `retail.cart.*` events follow. `orderId` / `paymentId` identify
// the row; `amountMinor` is the authorized amount in integer minor units (cents).
// `eventVersion` is pinned to `'v1'`; `occurredAt` is an ISO-8601 string.
export interface IRetailPaymentAuthorizedEvent extends ICorrelationPayload {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  eventVersion: 'v1';
  occurredAt: string;
}
