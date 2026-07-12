import { ICorrelationPayload } from '../../microservices';

// `retail.refund.failed` — a **reserved surface** (README §2). Not dead code.
//
// **It is also unreachable.** The bound payment gateway is a fake that always succeeds, so no code
// path emits it; it is modelled so that a real processor's decline has somewhere to land. Do not
// write a test that expects to observe it, and do not conclude from its silence that refunds
// cannot fail.
//
// On a decline the `Refund` walks `pending → failed` (terminal) and the `Payment` is left
// untouched. `failureReason` carries the gateway's detail. `occurredAt` is ISO-8601.
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
