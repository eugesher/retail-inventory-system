import { ICorrelationPayload } from '../../microservices';

// `retail.cart.created` — a **reserved surface** (README §2): emitted with nothing bound to it,
// deliberately, and captured by the event-store firehose regardless. Not dead code.
//
// `customerId` is `null` for a **guest** cart. `occurredAt` is ISO-8601.
export interface IRetailCartCreatedEvent extends ICorrelationPayload {
  cartId: string;
  customerId: string | null;
  currency: string;
  eventVersion: 'v1';
  occurredAt: string;
}
