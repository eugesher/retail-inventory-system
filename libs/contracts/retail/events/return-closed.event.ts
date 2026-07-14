import { ICorrelationPayload } from '../../microservices';

// `retail.return.closed` — a **reserved surface** (README §2). Not dead code.
//
// Closure is terminal and stamps `closedAt`. **Closing an RMA does not refund it**: refunds are
// issued through `retail.refund.issue` against a captured payment, and nothing consumes this
// event to trigger one. A closed RMA with money owed still needs the refund raised explicitly.
//
// This is the internal-status half of the returns eventing split — the buyer-facing
// `requested` / `authorized` / `received` / `inspected` events go to `notification_events`.
// `occurredAt` and `closedAt` are ISO-8601.
export interface IRetailReturnClosedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  closedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
