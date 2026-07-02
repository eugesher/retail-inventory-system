# Optimistic concurrency on the operational aggregates: Cart, and the `If-Match` + `409 VERSION_MISMATCH` contract

Inventory already resolves concurrent writes to a single row with a version-checked
compare-and-swap wrapped in a bounded retry (see
[`03-occ-on-stocklevel-reservation.md`](03-occ-on-stocklevel-reservation.md)). The
operational aggregates — `Cart`, `Order`, `Fulfillment`, `ReturnRequest` — all **ship a
`version` column** but historically did not consume it, so two concurrent writers to one
aggregate (two browser tabs editing one cart, a ship racing a cancel, two staff editing one
order) could silently lose an update.

This document describes turning that shipped-but-unenforced column into a real optimistic-
concurrency (OCC) layer, starting with the **cart write path** and the **client contract**
every aggregate shares: the optional `If-Match` precondition and the uniform
`409 VERSION_MISMATCH` wire code. The order-side aggregates (`Order`, `Fulfillment`,
`ReturnRequest`) adopt the identical protocol described here; their write paths are covered
alongside their own persistence.

Related decisions: [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) (the
enforced OCC, the configurable retry budget, the `409 VERSION_MISMATCH` translation, and the
`If-Match` convention), [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) (the
mutable `Cart` aggregate, its `version` column, and the `throwRpcError` typed-code
forwarding), and [ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
(the bounded optimistic write protocol this generalizes).

## The correctness rule

A cart is a mutable working set of lines with a running subtotal. Two writers that both read
the same cart, both decide their edit is valid, and both write back would lose one update —
one shopper's "add line" or "change quantity" vanishes. Worse, the cart also drives
inventory: an add/change **reserves** the line's absolute target quantity before saving, so a
lost update can leave a hold that no longer matches the persisted cart. OCC closes both holes
by making concurrent writers serialize through the cart root's `version`, with exactly one
winner per version.

## The OCC contract (read-version → mutate → version-checked persist)

Each cart mutator (`AddToCartUseCase`, `ChangeCartLineQuantityUseCase`,
`RemoveFromCartUseCase`) follows the same protocol, mirroring the inventory write protocol:

1. **Load** the cart, capturing its `version` **before** any mutation.
2. **Reserve/release** the affected inventory (add/change reserve the absolute target;
   remove releases after the save). The reserve RPC is idempotent-by-absolute-quantity, so it
   is safe to re-run.
3. **Mutate** the aggregate in memory (`addLine` / `changeLineQuantity` / `removeLine`), which
   enforces the domain invariants (unknown line → `CART_LINE_NOT_FOUND`, a non-active cart →
   `CART_NOT_ACTIVE`, and so on).
4. **Persist with a compare-and-swap on the cart root:**
   `UPDATE cart SET …, version = version + 1 WHERE id = :id AND version = :expectedVersion`.
   The root `version` is the OCC anchor for the **whole aggregate** — even a pure line edit
   (which changes no root column) bumps it, so two concurrent line writes serialize through
   this one `UPDATE`. Zero rows affected means a concurrent writer already advanced the
   version — a lost race, surfaced as an internal `CartWriteConflictError`.
5. **On a lost race:** re-read the now-current cart and retry the whole step from a fresh read
   (re-loading also **re-computes the absolute reserve target**, which depends on the current
   line quantity), up to `OCC_RETRY_ATTEMPTS` attempts. On exhaustion the write surfaces a
   `409 VERSION_MISMATCH` carrying the row's current version.

The whole read-reserve-mutate-persist sequence runs inside a shared bounded-retry helper,
`runWithCartWriteRetry`, the cart-side analogue of inventory's `runWithStockWriteRetry`. A
domain rejection (a bad line id, a stale `If-Match`, an out-of-stock reserve) propagates
immediately and is **never** retried; only a `CartWriteConflictError` triggers a retry.

Because the CAS and its unit of work live inside `CartTypeormRepository.save(cart,
expectedVersion)`, the cart helper needs no transaction port — an attempt is a plain
`async () => …` the helper re-invokes. The repository translates a zero-rows CAS into the
conflict signal, re-reading the committed current version on a fresh query (not the rolled-
back transaction's snapshot) so the signal carries the accurate version the caller should
refetch.

### The configurable retry budget

The attempt count is `OCC_RETRY_ATTEMPTS` (Joi-validated `integer().min(1)`, default **5**),
resolved from the environment through a `ConfigService`-backed value-provider token and
injected into each use case as a plain `number` — never read from `process.env` inside the
application layer ([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)). It is
the same knob inventory uses; the default of 5 keeps the high-contention concurrency tests
converging (see [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md)).

### Auditability

A lost race that is retried logs at `info` (the correlation id, the cart id, the attempt
number, the budget, and the current version the winner left behind). Exhaustion logs at
`warn` before raising the `409`. This mirrors the inventory protocol's trace so the
concurrency behavior is observable under contention.

## The `If-Match` convention

A client that holds a known cart version may pin it. The three cart line routes accept an
**optional** `If-Match: <version>` header carrying the `version` the client last read
(surfaced on `CartView.version`):

```
PATCH /api/cart/{cartId}/lines/{lineId}
If-Match: 4
```

- **Header shape.** A bare non-negative integer version. A surrounding pair of double quotes
  (ETag style, `If-Match: "4"`) is tolerated. A present-but-malformed value (non-integer /
  negative) fails fast at the gateway edge with `400 { code: 'IF_MATCH_INVALID' }` — a
  precondition is never silently ignored, because ignoring it would let the write proceed
  unguarded.
- **Precondition-failed semantics.** When the header is present and the loaded cart's version
  differs, the client's view is already stale, so the write is rejected **immediately** with
  `409 VERSION_MISMATCH` (carrying `details.currentVersion`) and is **not** retried. Retrying
  would defeat the precondition: the client explicitly asked to enforce "only if the cart is
  still at version N", so a last-writer-wins retry loop must not override it. Concretely, an
  `If-Match` write runs with a retry budget of exactly **one** attempt — both the stale-at-
  load case and a lost CAS between load and write resolve to the same immediate `409`.
- **When it is absent.** No precondition is enforced; the bounded retry makes the last writer
  within the budget win. This is the convenient default for a single-tab shopper who does not
  care about detecting a concurrent edit.

The precondition is threaded from the edge to the domain with a reusable `@IfMatch()`
parameter decorator (the gateway's `common/decorators/`), which parses the header into an
`expectedVersion: number | undefined` folded onto the command. The retail use case honors it
via `assertCartVersion(cart, expectedVersion)`.

## The uniform `409 VERSION_MISMATCH` (two layers)

A client should branch on **one** stable code regardless of which aggregate or service lost
the race. The cross-service wire code is `VERSION_MISMATCH` (not a cart-specific
`CART_VERSION_*`), and the current version rides along in `details.currentVersion` so the
client can refetch-and-retry. Two layers emit it:

### Layer 1 — the microservice RPC filter (cross-service writes)

The cart context owns a `CartErrorCodeEnum.CART_VERSION_MISMATCH` whose **member name** keeps
the module's `CART_` prefix but whose **wire value** is the uniform `VERSION_MISMATCH`. The
`CartRpcExceptionFilter` maps it to HTTP `409` and forwards the exception's structured
`details` (`{ currentVersion }`) — exactly how inventory forwards `{ available }` on an
out-of-stock rejection ([ADR-030 §6](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)).
Inventory keeps its own `STOCK_WRITE_CONFLICT` code (also a `409`); `VERSION_MISMATCH` is the
operational-aggregate name for the same class of optimistic conflict.

The gateway's `throwRpcError` already forwards any `409` (indeed any 4xx/5xx that carries a
typed `code`) together with its `code` and object-valued `details` verbatim
([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)), so the client receives:

```json
{ "statusCode": 409, "message": "…", "code": "VERSION_MISMATCH", "details": { "currentVersion": 5 } }
```

### Layer 2 — the gateway-global filter (gateway-local OCC)

A gateway-global exception filter, `OptimisticLockExceptionFilter`, maps TypeORM's
`OptimisticLockVersionMismatchError` to the same `409 { code: 'VERSION_MISMATCH',
currentVersion }`. It is registered as an `APP_FILTER` provider (beside the existing
duplicate-key filter). The gateway's own TypeORM writes (the `auth` aggregates) carry no
version columns today, so in practice this is **defense-in-depth + the normalized contract +
the documented convention** — but it makes the gateway honor `VERSION_MISMATCH` uniformly the
moment any gateway-local aggregate adopts optimistic locking, so a lost gateway-side CAS never
leaks a raw `500`. TypeORM bakes the versions into the error message rather than exposing them
as fields, so the filter recovers the current version by parsing the message and omits
`currentVersion` when it cannot.

## What this does and does not change

- **Cart add / change / remove are version-checked.** Two concurrent edits to one cart resolve
  to exactly one winner; the loser either retries (no `If-Match`) or gets a `409` (a stale
  `If-Match`, or the budget exhausted).
- **The create path is unchanged.** A brand-new cart has no live row to race, so
  `CartTypeormRepository.save` without an `expectedVersion` falls back to a plain insert.
- **Cart claim** (`reassignCustomer`) remains a direct column update — a guest-promotion is not
  a contended edit path.
- **The reserve/release inventory calls stay in place**; the only change is that add/change
  re-run the reserve on a retry (idempotent by absolute quantity) so a re-read never
  under-reserves.
