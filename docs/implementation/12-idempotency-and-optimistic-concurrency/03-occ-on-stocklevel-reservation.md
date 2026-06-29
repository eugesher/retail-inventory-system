# Optimistic concurrency on `StockLevel` and `Reservation`

Inventory is the part of the system where two requests most often collide on one row:
two carts racing for the last unit, a Receive landing while an Adjust is in flight, an
Allocate competing with a Release. The correctness rule is **no oversell** —
`available = quantityOnHand − quantityAllocated − quantityReserved` must never go negative —
and it has to hold under concurrency, not just in a single-threaded happy path.

This document describes how that guarantee is implemented with **optimistic concurrency
control (OCC)**: a version-checked compare-and-swap wrapped in a bounded retry, with the
retry budget now driven by a single configurable knob rather than a constant baked into the
code.

Related decisions: [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) (the
configurable budget + the wider hardening capability),
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) (the bounded
optimistic write protocol and the reservation hold),
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md) (the `StockLevel`
running totals and the `version` column), and
[ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) (post-commit cache
invalidation).

## What optimistic concurrency means here

`StockLevel` keeps **running totals** — `quantityOnHand`, `quantityAllocated`,
`quantityReserved` — and `available` is a pure getter over them, never a re-derived sum of
history ([ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)). Because the
totals are the source of truth, two writers that both read the same row, both decide their
change is valid, and both write back would silently lose one update. OCC prevents that
without locking.

Each `stock_level` row carries a `version` integer (a TypeORM `@VersionColumn`). The write
protocol is **read-version-then-write-with-version**:

1. Read the row inside a transaction, capturing its `version` **before** any mutation.
2. Mutate the aggregate in memory (`changeOnHand`, `reserve`, `releaseReserved`,
   `allocateFromReserved`, `releaseAllocated`, `commitSale`), which enforces the domain
   invariant (a result that would push a counter below zero throws immediately).
3. Persist with a compare-and-swap:
   `UPDATE stock_level SET …, version = version + 1 WHERE id = :id AND version = :expectedVersion`.

If a concurrent writer advanced the row between steps 1 and 3, the `WHERE … AND version =
:expectedVersion` predicate matches **zero rows**. The repository
(`StockTypeormRepository.persistStockLevelChange`) detects the zero-rows result and throws an
internal `StockWriteConflictError` — a retry signal, deliberately **not** a
`InventoryDomainException`, so it never leaks to the caller unchanged. A first-touch write
(no row existed at read time) takes a plain `INSERT` and lets the
`UNIQUE (variant_id, stock_location_id)` constraint arbitrate; the loser of that INSERT race
is translated into the same `StockWriteConflictError`.

`Reservation` participates in the same protocol. A hold's `quantity`, while `active`, is
counted into `StockLevel.quantityReserved`, so reserving, refreshing, releasing, or allocating
a hold is always a `StockLevel` write under the CAS above. A first Reserve for a
`(cartId, variantId, stockLocationId)` triple `INSERT`s a `reservation` row; if it loses the
race on the all-statuses UNIQUE triple, the repository translates the duplicate-entry error
into a `StockWriteConflictError` so the retry re-reads the now-present row and converges on
`reactivate` rather than failing
([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)).

## The bounded retry protocol

The retry lives in one place — `runWithStockWriteRetry` in
`apps/inventory-microservice/src/modules/stock/application/use-cases/stock-mutation.ts` —
and every counter-changing use case routes through it (directly, or via `applyOnHandChange`
for the on-hand mutations Receive and Adjust). The contract:

- **A fresh transaction per attempt.** Each attempt calls
  `transactionPort.runInTransaction(...)`, so a retried attempt re-reads the **now-current**
  version under a new snapshot. A failed attempt's in-memory mutations are discarded; nothing
  is double-applied.
- **Only a conflict is retried.** A caught `StockWriteConflictError` triggers a retry. **Every
  other error propagates immediately** — a domain rejection (`OUT_OF_STOCK`, a below-zero
  `STOCK_RESULT_NEGATIVE`) is a real `400`/`409` the caller must see at once, never something
  to retry. A genuinely out-of-stock request fails fast.
- **Exhaustion is a `409`.** When the budget is spent the helper throws
  `InventoryDomainException(STOCK_WRITE_CONFLICT)`, which the presentation filter maps to
  `409 Conflict` — the caller may simply retry the request.
- **The ledger append sits after the CAS.** When a use case writes a `StockMovement`, the
  append runs *after* the version-checked persist inside the same transaction, so a losing
  attempt throws before it writes a movement and never leaves an orphaned ledger row. Exactly
  one movement lands per successful mutation, regardless of how many attempts the race burned.

### OCC retries are observable at `info`

A lost compare-and-swap is a **normal, expected** outcome under contention, not an error — so
the per-attempt retry trace is logged at **`info`** (it was previously `debug`). Each retry
emits:

```
{ correlationId, variantId, stockLocationId, attempt, maxAttempts, fromVersion }
```

The `variantId` / `stockLocationId` come from the conflict signal itself, which is more
precise than the call context for a multi-row write (Release / Allocate span several rows).
`fromVersion` is the `version` the compare-and-swap targeted — the value this attempt read the
row at and lost the race against. The *winning* version is intentionally **not** logged: the
conflict path is kept query-free (it throws without re-reading the row), so only the
`fromVersion` we already held is surfaced. Raising this line to `info` lets the concurrency
test suites assert that a contended write actually retried, and how many times.

## The configurable budget (`OCC_RETRY_ATTEMPTS`)

The number of attempts is no longer a constant in the code. It is the environment variable
**`OCC_RETRY_ATTEMPTS`**, validated by the shared Joi schema as `integer().min(1)` and
**defaulted to `5`** (a missing var never fails boot, the `RESERVATION_TTL_MINUTES`
precedent).

**Why 5.** The default has to keep the high-contention concurrency tests green — for example,
50 concurrent `Receive +1` writes that must converge to `seed + 50` with no lost updates. A
budget of `3` risks flakiness under that fan-out; `5` converges reliably while still bounding
a genuinely stuck write to a fast `409`. The value is a single operational knob: raise it for
a workload with heavier contention, lower it to fail faster, without touching code.

**How it reaches the use case — through DI, never `process.env`.** The application layer is
transport- and environment-free ([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)).
So the budget is wired exactly like the reservation TTL:

- A value-provider token `OCC_RETRY_ATTEMPTS` lives at
  `…/stock/application/ports/occ-retry-attempts.token.ts`.
- The stock Nest module binds it to a `ConfigService`-backed factory that resolves
  `OCC_RETRY_ATTEMPTS` (falling back to `5`), so the token resolves to a plain `number`.
- Every stock write use case injects that `number` and threads it into the retry dependency
  set (`IStockWriteRetryDeps.maxAttempts`); `runWithStockWriteRetry` counts down the injected
  value. No use case reads `process.env`, and there is no hardcoded attempt count anywhere in
  the protocol.

The retry budget is shared by **one** protocol — Receive, Adjust, Reserve, Release, Allocate,
Cancel-allocation, Commit-sale, Transfer, and Restock all consume the same `OCC_RETRY_ATTEMPTS`.
One protocol, one budget: a second knob would be a second thing to tune and reason about.

## Cache-invalidation ordering is preserved

OCC sits *inside* the cache-invalidation envelope, not the other way round. Every stock write
is structured as:

```
stockCache.withInvalidation(
  () => runWithStockWriteRetry(deps, attempt, context),   // the retried transaction
  (result) => [ /* the (variantId, stockLocationId) items to wipe */ ],
  { correlationId },
)
```

`withInvalidation` awaits the work — the whole bounded-retry transaction — and only then runs
the per-variant prefix delete, **after** commit
([ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md)). This ordering is what
keeps a Redis outage from ever corrupting correctness: invalidation is a post-commit
best-effort step, and a write that loses every retry and throws `409` performs **no** cache
mutation at all (the work rejected, so `withInvalidation` never reaches the prefix delete).
Adding the configurable budget changed only how many attempts the inner work makes; the
invalidation envelope around it is untouched.

## Where this fits

The inventory `StockLevel` / `Reservation` OCC described here is **already enforced** — it was
not added by this change. What this change did is make the retry budget a configurable,
DI-injected value (`OCC_RETRY_ATTEMPTS`) instead of a hardcoded constant, and raise the retry
trace to `info`. The same `OCC_RETRY_ATTEMPTS` budget and the `409`-on-exhaustion shape are
the template the operational aggregates (`Cart`, `Order`, `Fulfillment`, `ReturnRequest`)
adopt as their version-checked writes come online, where the exhaustion error is named
`VERSION_MISMATCH` rather than `STOCK_WRITE_CONFLICT`
([ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md)).
