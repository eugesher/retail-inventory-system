# No-oversell invariant and the optimistic write protocol

This note explains how the inventory service stops two carts from racing for the
last unit, and how the **Reserve Stock** and **Release Reservation** operations
keep the stock counters and the reservation holds consistent under concurrency.
It assumes only the repository as it stands — no planning materials.

Related decisions: [ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
(the reservation hold + the no-oversell guard), [ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)
(the `StockLevel` running totals + the `version` column this consumes),
[ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) (post-commit
cache invalidation). The cache key bump that ships alongside is documented in
[07-cache-key-bump-v2-to-v3.md](07-cache-key-bump-v2-to-v3.md).

## The invariant

A `StockLevel` (one row per `(variantId, stockLocationId)`) keeps three maintained
counters and a derived `available`:

```
available = quantityOnHand − quantityAllocated − quantityReserved
```

`available` is a pure getter, not a stored column — it is a *projection* of the
counters. Before this capability nothing guarded it: `available` could go
negative, and a unit test asserted exactly that. The no-oversell invariant we now
enforce is:

> A Reserve may not push `available` below zero. A request to hold `n` units
> succeeds only when `n ≤ available` at the moment of the write.

While a reservation is `active`, its `quantity` is counted into
`quantityReserved`, so it is subtracted from `available` immediately — the unit is
held the moment it lands in a cart, which is what powers a "only 1 left!" UX and
what stops two carts checking out the same last unit.

## Where the guard lives, and where the protocol lives

These are deliberately two different places:

- **The guard is a domain mutator.** `StockLevel.reserve(quantity)` is the only
  thing that knows the invariant. It throws a typed
  `InventoryDomainException(OUT_OF_STOCK, …, { available })` when
  `quantity > available`, and otherwise raises `quantityReserved` and bumps the
  in-memory `version`. Its counterpart `StockLevel.releaseReserved(quantity)`
  returns held units (and treats releasing more than is held as a plain `Error` —
  a counter-drift invariant breach, never a client-facing 4xx). The domain knows
  *what* is forbidden.

- **The protocol is a shared application helper.**
  `runWithStockWriteRetry(deps, attempt, context)` in
  `application/use-cases/stock-mutation.ts` knows *how* to apply a counter change
  atomically under contention. It was generalized out of the Receive/Adjust
  `applyOnHandChange` so every counter-moving operation shares one budget and one
  conflict policy.

Keeping the guard in the domain keeps it unit-testable without a database and
impossible to bypass; keeping the protocol in the application layer keeps the
domain free of transactions and retries (ADR-004 / ADR-017).

## The optimistic write protocol

The protocol is a read → mutate → version-checked persist, retried on conflict:

```
withInvalidation(                          // ADR-023: invalidate AFTER commit
  runWithStockWriteRetry(                   // bounded optimistic retry
    transaction(                            // one fresh tx per attempt
      read StockLevel (capture version)
        → domain mutate (reserve / releaseReserved)
          → persistStockLevelChange(level, expectedVersion)   // CAS UPDATE
    )
  ),
  resolveItems,                             // → the (variantId, stockLocationId) to wipe
)
```

- **`expectedVersion` is captured before the mutation.** `persistStockLevelChange`
  issues `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?`. If a
  concurrent writer advanced the row first, the UPDATE matches zero rows and the
  repository throws `StockWriteConflictError`.
- **Only a conflict is retried.** `runWithStockWriteRetry` re-runs the attempt
  under a *fresh transaction* (so it re-reads the now-current version) up to
  `MAX_WRITE_ATTEMPTS = 5`. A domain rejection (`OUT_OF_STOCK`, a below-zero
  Adjust) is **not** a conflict — it propagates immediately, so a genuinely
  out-of-stock request fails fast rather than retrying five times.
- **Exhaustion is a 409.** When the budget is spent the helper throws
  `InventoryDomainException(STOCK_WRITE_CONFLICT)`, which the presentation filter
  maps to `409 Conflict` — the caller may simply retry.
- **One budget, not two.** Reserve, Release, Receive, and Adjust all share the
  same `MAX_WRITE_ATTEMPTS`; a second budget would be a second thing to tune.

### A reservation that loses the INSERT race converges, it does not fail

A first Reserve for a `(cartId, variantId, stockLocationId)` triple `INSERT`s a new
`reservation` row. If a concurrent writer wins that race, the database rejects the
duplicate on the all-statuses `UNIQUE (cart_id, variant_id, stock_location_id)`
constraint with `ER_DUP_ENTRY`. The reservation repository translates that into the
same `StockWriteConflictError`, so the retry re-reads the now-present row via
`findByKey` and converges on `refresh`/`reactivate` rather than failing — the same
budget, the same loop.

## Idempotent-by-absolute-quantity reserve (the Q9 refresh)

Reserve is **idempotent on the triple**. The request carries the *absolute* target
quantity, not a delta. Inside the transaction the use case reads the existing hold
(`findByKey`, any status) and branches:

| Existing row | Counter change | Hold change |
|---|---|---|
| none | `reserve(quantity)` | `Reservation.create(...)` |
| `active`, new qty > old | `reserve(delta)` | `refresh(quantity, expiresAt)` |
| `active`, new qty < old | `releaseReserved(−delta)` | `refresh(quantity, expiresAt)` |
| `active`, new qty == old | *(none)* | `refresh(quantity, expiresAt)` — TTL only |
| `released` / `expired` | `reserve(quantity)` | `reactivate(quantity, expiresAt)` |
| `committed` | — | `RESERVATION_INVALID_STATE` (409) |

The counter moves by **only the delta**, never the full quantity, so re-reserving
the same line twice never double-counts `quantityReserved`. Every write also
refreshes the TTL (`expiresAt = now + RESERVATION_TTL_MINUTES`, default 15,
env-tunable) — the "refresh on write" that keeps a still-wanted hold alive. When
the delta is zero the level is left untouched and `persistStockLevelChange` is
skipped (a version-checked UPDATE of nothing would be wasted work); the hold row is
still saved so its TTL and `version` advance.

The released/expired branch is why the UNIQUE triple spans *all* statuses: a
re-added line reuses the prior row (`reactivate`) instead of inserting a second one.

## Structured error details

The out-of-stock rejection carries the live number, not just a message:

```jsonc
{ "statusCode": 409, "code": "INVENTORY_OUT_OF_STOCK", "message": "…", "details": { "available": 2 } }
```

`InventoryDomainException` gained an optional `details` field; the
`InventoryRpcExceptionFilter` forwards it on the wire when present. A client can
branch on `details.available` ("only 2 left") instead of parsing prose. (The
gateway error util forwards `details` once the retail-facing wiring teaches it to;
until then the field is harmlessly dropped at the gateway edge.)

## Release writes an audit trail

Release returns held units to `available` (`releaseReserved`), flips the row to
`released`, and **appends one negative `release` movement** to the `stock_movement`
ledger per released hold (`quantity = −held`, `referenceType = 'cart'`,
`referenceId = cartId`, `reasonCode` = the release reason). The ledger is an audit
trail, not the balance authority — the running totals stay the source of truth — so
a released hold leaves a trail without the row sums ever being expected to
reconstruct on-hand.

Release accepts exactly one selector family: `reservationId` (one row; 404 on an
unknown id, 409 on a non-active one — the precise ops/cleanup path hears "already
released") or `cartId` (+ optional `variantId` / `stockLocationId`, all matching
*active* rows; an empty match is an idempotent no-op so remove-after-remove never
errors). Supplying both or neither is `RESERVATION_SELECTOR_INVALID` (400).

## Post-commit cache invalidation is preserved

Both operations run their transaction inside `stockCache.withInvalidation(work,
resolveItems, opts)`. The helper awaits `work` (the commit) and only then fires the
prefix delete — the post-commit ordering is type-enforced (ADR-023): there is no
public `invalidate(...)` to call from inside a transaction. `resolveItems` derives
the `(variantId, stockLocationId)` pairs to wipe from the committed result (the new
hold for Reserve; the distinct pairs across all released rows for Release). A
rejected `work` rethrows before any cache mutation, so an `OUT_OF_STOCK` or an
exhausted retry leaves the cache untouched.
