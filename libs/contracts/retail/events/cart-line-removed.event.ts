import { ICorrelationPayload } from '../../microservices';

// `retail.cart.line-removed` — a **reserved surface** (README §2). Not dead code.
//
// `lineId` is the `cart_line.id` of a row that no longer exists by the time a consumer reads
// this. `occurredAt` is ISO-8601.
export interface IRetailCartLineRemovedEvent extends ICorrelationPayload {
  cartId: string;
  lineId: number;
  eventVersion: 'v1';
  occurredAt: string;
}
