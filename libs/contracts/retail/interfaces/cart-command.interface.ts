import { ICorrelationPayload } from '../../microservices';

// Wire-format command payloads for the six cart RPCs (API Gateway → Retail). Each
// extends `ICorrelationPayload` so the correlation id threads through to the
// retail handler's inline logging (ADR-001 / ADR-011). They are the single source
// of truth for both ends: the gateway `CartRabbitmqAdapter` sends them and the
// retail cart use cases consume them as their `execute(payload)` input, so a drift
// fails TypeScript on both sides (the contract test).
//
// `customerId` is the resolved caller (the gateway folds `@CurrentUser().id` in).
// Carrying it on the read/write commands lets each retail use case re-assert
// `cart.customerId === payload.customerId` as defense-in-depth, in addition to
// the gateway's owner-check (ADR-028 §7) — the retail service never blindly
// trusts the edge.

// `retail.cart.create` — opens a new active cart for the caller. `currency` is
// optional; the use case defaults it to `'USD'`.
export interface IRetailCartCreatePayload extends ICorrelationPayload {
  customerId: string;
  currency?: string;
}

// `retail.cart.get` — reads a cart by id (owner-checked).
export interface IRetailCartGetPayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
}

// `retail.cart.add-line` — adds (or increments) a line for `variantId`. The price
// is snapshotted server-side via `catalog.price.select` — the caller never sends
// a price.
export interface IRetailCartAddLinePayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  variantId: number;
  quantity: number;
}

// `retail.cart.change-line-quantity` — sets a line's quantity to a new positive
// value (a `0` is rejected — removal is the explicit op).
export interface IRetailCartChangeLineQuantityPayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  lineId: number;
  quantity: number;
}

// `retail.cart.remove-line` — drops a line from the cart.
export interface IRetailCartRemoveLinePayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  lineId: number;
}

// `retail.cart.claim` — promotes a guest cart to a registered customer. The
// re-point happens only if `cart.customerId === fromCustomerId` (knowing the
// guest id is the ownership proof); `newCustomerId` is the registered customer
// the gateway resolved from the bearer token (ADR-028 §1, Q1/Q7).
export interface IRetailCartClaimPayload extends ICorrelationPayload {
  cartId: string;
  fromCustomerId: string;
  newCustomerId: string;
}
