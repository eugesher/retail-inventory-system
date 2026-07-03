# The `.http` walkthroughs for idempotency and optimistic concurrency

The retail write surface now enforces two client-facing preconditions that a manual caller
has to *see* to trust: a **required, deduplicated `Idempotency-Key`** on the four
money-/stock-moving writes (place order, capture payment, ship fulfillment, issue refund),
and an **optional `If-Match: <version>`** optimistic-concurrency precondition on the cart line
writes ([ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md)). The Kulala
`http/*.http` files under `http/` are the executable documentation of the HTTP surface, so
they carry runnable blocks that demonstrate each observable outcome — a live replay, a
key-reuse rejection, and a stale-version rejection — rather than only describing them in prose.

This document explains what changed in those files, the one non-obvious idiom that makes a
replay demonstrable, and the operator workflow for observing each outcome. The store and TTL
behind these calls are documented in
[02-idempotency-key-store-and-ttl.md](02-idempotency-key-store-and-ttl.md); the "a replay
emits no duplicate events" guarantee in
[06-replay-does-not-republish-events.md](06-replay-does-not-republish-events.md); the cart /
order / return OCC in
[04-occ-on-cart-order-fulfillment-returnrequest.md](04-occ-on-cart-order-fulfillment-returnrequest.md).

## What changed in the `.http` files

### The idempotent writes (`order.http`, `fulfillment.http`, `refunds.http`)

Each of the four idempotent operations now appears as a **trio** of requests:

1. **The original** — the write itself, carrying `Idempotency-Key: {{…Key}}` (a captured
   request variable, see below). A fresh key executes the operation and returns its real
   response (`201` for place / refund, `200` for capture / ship).
2. **The replay** (`…Replay`) — the *same* key and the *same* body. The store recognizes the
   key and its matching fingerprint and short-circuits **before any side effect**: no second
   order, no second gateway call, no second `commit-sale`, no re-emitted events — and, for
   refund, **no second `audit_log_entry`**. The response is the stored body with **`200`** and
   the header **`Idempotent-Replay: true`**.
3. **The different-body reuse** (`…DifferentBody`) — the *same* key but a *changed* body. The
   stored fingerprint no longer matches, so the request is rejected **without executing**:
   `422 { code: "ORDER_IDEMPOTENCY_KEY_REUSED" }`.

The trio lives in:

| File | Operation | Original / Replay / Different-body |
|---|---|---|
| `order.http` | Place Order | `placeOrder` / `placeOrderReplay` / `placeOrderDifferentBody` |
| `order.http` | Capture Payment | `capturePayment` / `capturePaymentReplay` (capture is `200` both fresh and on replay, so the header is the only wire difference — no different-body block needed to make the point) |
| `fulfillment.http` | Ship Fulfillment | `shipFulfillment` / `shipFulfillmentReplay` / `shipFulfillmentDifferentBody` |
| `refunds.http` | Issue Refund | `issueRefund` / `issueRefundReplay` / `issueRefundDifferentBody` |

`order.http` also keeps `placeOrderAgain` — a re-place on the now-`converted` cart with a
**new** key. That is a store *miss*, so it returns `201` with no `Idempotent-Replay` header;
the durable cart-conversion backstop (not the key store) is what returns the same order. It is
retained to contrast the two layers: the key store gives a `200` replay only on a real key
hit, while cart state still prevents a second order under a brand-new key.

The **missing-key** outcome (`400 IDEMPOTENCY_KEY_REQUIRED`) is documented in each file's
header comment rather than shown as a block, because a Kulala request cannot conditionally
omit a header it templates — deleting the `Idempotency-Key:` line by hand reproduces it.

### The cart `If-Match` precondition (`cart.http`)

`cart.http` carries the optimistic-concurrency half. The three line writes
(`addLine` / `changeLineQuantity` / `removeLine`) accept an optional `If-Match: <version>`
header carrying the cart `version` the client last read (`CartView.version`):

- `changeLineQuantity` pins `If-Match: {{cartVersion}}` (captured from the preceding
  `addLine` response) — a **matching** version, so the write proceeds.
- `changeLineQuantityStaleIfMatch` pins a deliberately stale `If-Match: 0` — the cart has
  moved past version 0 after the add, so the write is rejected **without retrying**:
  `409 { code: "VERSION_MISMATCH", details: { currentVersion } }`.

The client's recovery is to refetch the cart (`GET /api/cart/:cartId`), read the new
`version`, and retry. Absent the header, a lost race is instead retried within the OCC budget
before the same `409` — so `If-Match` is a *stricter* client opt-in (fail fast on a stale
pin) layered over the default last-writer-within-budget behavior.

## The shared-key idiom

The one non-obvious mechanic is why the key is captured into a variable. Kulala's dynamic
variable `{{$guid}}` (a fresh UUID) is regenerated **every time it is substituted** — so if
both the original and the replay wrote `Idempotency-Key: {{$guid}}` inline, they would send
two *different* keys and the "replay" would just be a second fresh write. A replay can only be
demonstrated when the two requests carry the **identical** key.

The files therefore capture the key **once** into a request variable and reference that
variable in both the original and its replay:

```
# Capture the place key ONCE so placeOrder and placeOrderReplay share it.
@placeKey = {{$guid}}

# @name placeOrder
POST {{baseUrl}}/cart/{{cartId}}/place
Idempotency-Key: {{placeKey}}
…

###
# @name placeOrderReplay   → same {{placeKey}}, same body → 200 + Idempotent-Replay: true
```

`@placeKey` / `@captureKey` / `@shipKey` / `@refundKey` hold the value for the run, so the
original and its replay share one key while a *re-run of the whole file* mints a fresh key
(and thus a fresh `201`/`200`). If a particular client re-evaluates the dynamic variable on
each reference, an operator can force a stable key by replacing the capture line with a
literal, e.g. `@placeKey = replay-demo-0001` — any past-that-key run will then reply `200`
immediately until the TTL purge reclaims the row.

## Operator workflow

To observe each outcome end-to-end (after the file's `Prereqs:` login + setup blocks):

1. **A live replay.** Run the original (`placeOrder` / `capturePayment` / `shipFulfillment` /
   `issueRefund`), then its `…Replay` sibling. The replay's status line is `200` and its
   response headers include `Idempotent-Replay: true`; the body is byte-for-byte the stored
   response (same `id` / `orderNumber` / `gatewayReference`). Nothing moved — no second order
   row, no second gateway charge, and (for refund) no second audit row.
2. **A key-reuse `422`.** Run the `…DifferentBody` sibling. It reuses the same captured key
   with a changed field, so it returns `422` with `code: "ORDER_IDEMPOTENCY_KEY_REUSED"` and never
   executes — the safeguard against a client accidentally reusing one key for two distinct
   requests. For refund, the `422` fires *before* any gateway call, so the changed (larger)
   amount can never slip through as an over-refund.
3. **A stale-version `409`.** In `cart.http`, run `addLine` (captures `@cartVersion`), then
   `changeLineQuantityStaleIfMatch` (pins `If-Match: 0`). It returns
   `409 { code: "VERSION_MISMATCH", details: { currentVersion } }` — refetch the cart, read
   the current `version`, and retry with the fresh value.

## The TTL purge, cross-linked

The store these calls dedup against is bounded by a scheduled purge that deletes rows past
`expires_at`. Its cadence, the `deleteExpired(now)` port method (with its explicit-`now`
testing seam), the `PurgeExpiredIdempotencyKeysUseCase`, and the `IdempotencyPurgeScheduler`
are documented in
[02-idempotency-key-store-and-ttl.md § The scheduled purge](02-idempotency-key-store-and-ttl.md#the-scheduled-purge).
The purge is invisible to these `.http` walkthroughs — a replay works whether or not the row
has been swept, because a not-yet-swept expired row is still served as a harmless replay and a
swept one simply re-executes on the next call.
