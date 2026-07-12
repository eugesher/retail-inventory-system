import { ICorrelationPayload } from '../../microservices';

// `retail.payment.authorized` — a **reserved surface** (README §2). Not dead code.
//
// `amountMinor` is the **authorized** amount, not a captured one: no money has moved when this
// fires. `occurredAt` is ISO-8601.
export interface IRetailPaymentAuthorizedEvent extends ICorrelationPayload {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  eventVersion: 'v1';
  occurredAt: string;
}
