import { ICorrelationPayload } from '../../microservices';

// `retail.payment.captured` — a **reserved surface** (README §2). Not dead code.
//
// This is the event on which money actually moves (`authorized → captured`). `amountMinor` is the
// captured amount. `occurredAt` is ISO-8601.
export interface IRetailPaymentCapturedEvent extends ICorrelationPayload {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  eventVersion: 'v1';
  occurredAt: string;
}
