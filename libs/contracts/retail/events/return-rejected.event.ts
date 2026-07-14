import { ICorrelationPayload } from '../../microservices';

// `retail.return.rejected` — a **reserved surface** (README §2). Not dead code.
//
// Rejection is terminal, and it stamps `closedAt` — the same field a *successful* closure stamps.
// A consumer cannot tell the two apart from `closedAt` alone; the routing key is the only
// discriminator.
//
// This is the internal-status half of the returns eventing split — the buyer-facing events go to
// `notification_events`. `reason` is optional and human-supplied. `occurredAt` and `closedAt` are
// ISO-8601.
export interface IRetailReturnRejectedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  closedAt: string;
  reason: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
