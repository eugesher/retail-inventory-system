import { ICorrelationPayload } from '../../microservices';

// `retail.cart.line-added` — a **reserved surface** (README §2). Not dead code.
//
// It also fires when an **existing** line's quantity is incremented: adding a variant already in
// the cart increments rather than duplicating (ADR-028 §1), so a consumer must not read this as
// "a new line appeared". `quantity` is the amount added, not the resulting total. `occurredAt` is
// ISO-8601.
export interface IRetailCartLineAddedEvent extends ICorrelationPayload {
  cartId: string;
  variantId: number;
  quantity: number;
  eventVersion: 'v1';
  occurredAt: string;
}
