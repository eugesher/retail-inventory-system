# 08 — The `Idempotency-Key` header (accepted, not deduped)

Placing an order is a money-moving, non-idempotent-looking operation: a client that
retries after a dropped response must not create a second order. This document
explains how repeat-safety actually works in this capability — **cart-state
idempotency**, not the `Idempotency-Key` header — and why the header is accepted and
logged but deliberately **not** enforced yet (Q10 /
[ADR-028 §6](../../adr/028-cart-order-payment-and-address-chain.md)).

## The header is accepted, forwarded, and logged — but not deduped

`POST /api/cart/:cartId/place` reads an `Idempotency-Key` request header
(`@Headers('idempotency-key')`). The gateway forwards it on the `retail.cart.place`
RPC payload, and both the gateway use case and the retail Place Order use case log it
inline alongside the correlation id. That is the full extent of its handling today:
**there is no persisted idempotency store, and the key is never used to deduplicate
or to short-circuit a replay.**

This is a deliberate staging decision. A correct key-based dedupe needs a durable,
atomically-claimed idempotency record (first request claims the key and stores its
response; a concurrent or later request with the same key returns the stored
response or blocks). That store, its TTL/elision policy, and its race semantics are a
capability of their own — wiring a half-working version now would be worse than
none. The header is wired through end-to-end so a client can start sending it today
and the contract does not change when real dedupe lands.

## Repeat-safety today: cart-state idempotency

Repeat-place safety in this chain is driven by **cart state**, which the schema
already enforces:

1. Placing an order marks its source cart `converted` — a terminal status. The
   conversion and the order insert commit in the **same transaction**, so a cart is
   never `converted` without its order, and never has an order without being
   `converted`.
2. The order records the cart it came from in `source_cart_id`.
3. A second place on the same cart observes `status = converted` and, instead of
   building a new order, looks the existing order up by `source_cart_id`
   (`IOrderRepositoryPort.findBySourceCartId`) and returns it — **with its
   payment** — unchanged.

So re-placing a cart is naturally a no-op that returns the order it already converted
into. No duplicate order, no second authorization, no second cart conversion. This
holds regardless of whether the client sent an `Idempotency-Key`, sent a different
one on the retry, or sent none — which is exactly why the header is not load-bearing
yet.

### What cart-state idempotency does and does not cover

It covers the **realistic** retry: a client places a cart, the response is lost, the
client retries the same cart. It does **not** cover a client that races two
concurrent places on the same `active` cart in the window before either commits — two
in-flight transactions could both read `active`. The `Idempotency-Key` store is what
will close that window; until then the walking skeleton accepts the small race, and
the database's one-order-per-converted-cart shape keeps the steady state correct.

## Why not enforce the key now

- **Correctness over theater.** A dedupe store that is not atomic is a false promise;
  cart-state idempotency is real and already enforced by the transaction boundary.
- **No contract churn.** The header is part of the request shape from day one, so
  adding real dedupe later is purely additive — no client has to change.
- **Honors the staged plan.** [ADR-028 §6](../../adr/028-cart-order-payment-and-address-chain.md)
  explicitly defers the persisted idempotency store and names cart state as the
  interim repeat-safety mechanism.

## Related documents

- [04 — Order-line snapshots](04-order-line-snapshot-and-cross-service-lookup.md).
- [07 — Authorize on place, capture explicit](07-authorize-on-place-capture-explicit-q5.md).
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md).
