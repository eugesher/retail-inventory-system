# 08 — The `Idempotency-Key` header (staged: accepted first, enforced later)

Placing an order is a money-moving, non-idempotent-looking operation: a client that
retries after a dropped response must not create a second order. This document
explains how repeat-safety actually works in this capability — **cart-state
idempotency**, not the `Idempotency-Key` header — and why the header is accepted and
logged but deliberately **not** enforced yet (Q10 /
[ADR-028 §6](../../adr/028-cart-order-payment-and-address-chain.md)).

> **⚠️ Superseded — read this first.** Everything below describes the *walking-skeleton*
> staging decision: the header accepted, logged, and **not** deduped. That was the
> honest interim, and the reasoning still holds as history — but the persisted store
> ADR-028 §6 named as future work has since landed
> ([ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md)). **Today the
> `Idempotency-Key` header is required and enforced** on Place Order (and on Capture,
> Ship, and Issue-Refund): the four money-/stock-moving writes fingerprint the canonical
> body, claim `(scope, key)` in the `IDEMPOTENCY_STORE`, and replay the stored response
> on a same-key/same-body retry (`Idempotent-Replay: true`, `200`); a same-key/different-body
> request is a `422`, a missing key a `400`. Cart-state idempotency (below) is still real,
> now as the **durable backstop underneath** the key store, not the only mechanism.

## At the walking-skeleton stage: accepted, forwarded, and logged — but not deduped

`POST /api/cart/:cartId/place` reads an `Idempotency-Key` request header. The gateway
forwards it on the `retail.cart.place` RPC payload, and both the gateway use case and
the retail Place Order use case log it inline alongside the correlation id. **At the
walking-skeleton stage that was the full extent of its handling: there was no persisted
idempotency store, and the key was never used to deduplicate or to short-circuit a
replay.** (Today it is — via the `IDEMPOTENCY_STORE`,
[ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md); the header is read by
the gateway's `@IdempotencyKey()` decorator, which now makes it **required**, not
optional.)

This was a deliberate staging decision. A correct key-based dedupe needs a durable,
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

## Why the key was not enforced *at the walking-skeleton stage*

This reasoning is why the header was staged rather than dedupe-enforced then — and the
prediction in the second bullet is exactly what let ADR-036 land additively later:

- **Correctness over theater.** A dedupe store that is not atomic is a false promise;
  cart-state idempotency was real and already enforced by the transaction boundary.
- **No contract churn.** The header was part of the request shape from day one, so
  adding real dedupe later was purely additive — no client had to change. (It landed
  this way: [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) added the
  store and flipped the header to required without changing the request shape.)
- **Honored the staged plan.** [ADR-028 §6](../../adr/028-cart-order-payment-and-address-chain.md)
  explicitly deferred the persisted idempotency store and named cart state as the
  interim repeat-safety mechanism.

## Related documents

- [04 — Order-line snapshots](04-order-line-snapshot-and-cross-service-lookup.md).
- [07 — Authorize on place, capture explicit](07-authorize-on-place-capture-explicit-q5.md).
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md).
