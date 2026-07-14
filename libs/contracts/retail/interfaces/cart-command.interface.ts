import { ICorrelationPayload } from '../../microservices';

// Wire-format command payloads for the six cart RPCs (ADR-028). One type, both ends: a drift fails
// TypeScript on the gateway *and* in retail. That is the contract test.
//
// **`customerId` rides on every command, including the reads, on purpose.** The gateway has
// already owner-checked; carrying the caller through lets each retail use case re-assert
// `cart.customerId === payload.customerId` itself. Retail does not trust the edge — remove this
// field and the only thing standing between a cart and a stranger is one guard in another
// deployable.
//
// **`expectedVersion` decides whether a lost race is retried or refused.** The gateway parses
// `If-Match: <version>` and threads it here. **Present:** a write whose loaded cart has moved on
// is rejected with `409 VERSION_MISMATCH` (carrying `details.currentVersion`) and is **not**
// retried — the client pinned a version, so silently resolving to a different one would answer a
// question it did not ask. **Absent:** the lost race is retried up to `OCC_RETRY_ATTEMPTS` before
// surfacing the same `409` (ADR-036/045).

// An omitted `currency` becomes `USD`.
export interface IRetailCartCreatePayload extends ICorrelationPayload {
  customerId: string;
  currency?: string;
}

export interface IRetailCartGetPayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
}

// **The caller never sends a price.** Add-line snapshots it server-side through
// `catalog.price.select`, so there is no field here to tamper with — and adding a variant already
// in the cart increments the existing line rather than opening a second one (ADR-028 §1).
export interface IRetailCartAddLinePayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  variantId: number;
  quantity: number;
  expectedVersion?: number;
}

// `quantity` must be positive: a `0` is rejected rather than treated as a removal, which is its
// own operation.
export interface IRetailCartChangeLineQuantityPayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  lineId: number;
  quantity: number;
  expectedVersion?: number;
}

export interface IRetailCartRemoveLinePayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  lineId: number;
  expectedVersion?: number;
}

// Promotes a guest cart to a registered customer. **Knowing the guest id IS the ownership proof** —
// the re-point happens only when `cart.customerId === fromCustomerId`, and a guest is a real,
// authenticatable row rather than a null owner (ADR-028 §1). `newCustomerId` is whoever the bearer
// token resolved to.
export interface IRetailCartClaimPayload extends ICorrelationPayload {
  cartId: string;
  fromCustomerId: string;
  newCustomerId: string;
}
