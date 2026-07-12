import { ICorrelationPayload } from '../../microservices';

// `retail.cart.line-quantity-changed` — a **reserved surface** (README §2). Not dead code.
//
// `quantity` is the new absolute quantity, and it is always **positive**: a `0` is rejected at the
// domain, because removal is its own operation. A consumer will never see this event announce a
// line's disappearance. `occurredAt` is ISO-8601.
export interface IRetailCartLineQuantityChangedEvent extends ICorrelationPayload {
  cartId: string;
  lineId: number;
  quantity: number;
  eventVersion: 'v1';
  occurredAt: string;
}
