# Reclaiming stranded reservations: the expired-hold sweep

A `Reservation` is a TTL-bounded hold on stock. Nothing observed its expiry, so an
abandoned cart's hold depressed `available` permanently. This document describes the
sweep that reclaims those holds — the scan, the two bounds it runs under, and the race it
settles without taking a lock. The whole design is recorded in
[ADR-038](../../adr/038-reservation-ttl-sweep-and-bounded-batches.md).

The use case is
`apps/inventory-microservice/src/modules/stock/application/use-cases/sweep-expired-reservations.use-case.ts`.
A timer drives it; how that timer is registered, and at what cadence, is the sibling note
[`02-sweeper-cron-and-emit-granularity.md`](02-sweeper-cron-and-emit-granularity.md).

## 1. The problem: a hold nobody reclaims

While a `Reservation` is `active`, its `quantity` is counted into
`stock_level.quantity_reserved`, and

```
available = quantity_on_hand − quantity_allocated − quantity_reserved
```

is a pure getter over those totals. That subtraction is the whole point — it is what stops
two carts racing for the last unit ([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)).

Three things return a hold to `available`, and **all three require someone to act**:

| Path | Trigger |
| --- | --- |
| `ReleaseReservationUseCase` | the shopper removes the cart line, or an operator releases by id |
| `AllocateStockUseCase` | the shopper places the order (the hold becomes an allocation) |
| `CancelAllocationUseCase` | the order is cancelled before fulfillment |

Now consider the shopper who adds the last three units of a variant to a cart and closes
the browser. The hold's `expiresAt` passes. `Reservation.expire()` exists —
`active → expired`, rejecting any other source state — and `isExpired(now)` exists. **But
expiry is a wall-clock fact, not a stored transition.** `reconstitute` loads a
past-`expiresAt` row as `active` because that is what the row says. No query filters on it.
Nothing flips it.

So `quantity_reserved` stays at 3 forever, `available` stays 3 lower than the physical
shelf, and those three units are unsellable and unreclaimable — not for fifteen minutes,
but for the life of the row. The only reachable freeing tool is an operator manually
releasing the hold by id, which requires a human to notice.

The sweep is what makes the TTL mean something.

## 2. The scan

One new method on `IReservationRepositoryPort` — the only one this capability adds:

```ts
listExpiredActive(now: Date, limit: number, scope?: ITransactionScope): Promise<Reservation[]>
```

implemented as

```sql
WHERE status = 'active' AND expires_at < :now
ORDER BY expires_at ASC, id ASC
LIMIT :limit
```

**Why the strict `<`.** `Reservation.isExpired(now)` is `expiresAt.getTime() < now.getTime()`:
a hold whose `expiresAt` equals `now` has not yet expired — it expires the instant the
clock passes it. The scan predicate must agree with the domain predicate, or a row would be
selected as a candidate and then skipped by the in-transaction `isExpired` re-check for no
reason. One boundary, stated once, honoured in both places.

**Which index serves it.** `IDX_RESERVATION_STATUS_EXPIRES_AT (status, expires_at)`, created
by `migrations/1781309334478-CreateReservationTable.ts` — before any sweep existed, for
exactly this scan. The composite narrows to `status = 'active'` first and then ranges on the
timestamp, so accumulated `expired` and `released` rows never enter the scan's working set.
**No migration was needed for this capability.**

**Why oldest-first.** The scan is capped (§3). Ordering by `expires_at ASC` means a capped
sweep reclaims the *longest*-stranded holds first — the ones whose units have been
unsellable the longest — and a backlog drains in the order it accumulated rather than at
the storage engine's whim. The `id ASC` tiebreaker makes the ordering **total**, so two
scans over an unchanged table return the same page. Without it, holds sharing an `expires_at`
could permute between scans and a capped batch could revisit the same subset while starving
its siblings.

**One clock per invocation.** `const now = new Date()` is captured once, at the top of
`execute`, and threaded into the scan predicate *and* into every in-transaction
`isExpired(now)` re-check. A sweep that takes a minute to grind through 200 rows must not
expire a hold that was still live when it began.

## 3. Two sizes, two jobs

| Env var | Default | Bounds |
| --- | --- | --- |
| `RESERVATION_SWEEP_BATCH_SIZE` | `200` | rows one invocation scans and expires |
| `RESERVATION_SWEEP_TRANSACTION_SIZE` | `25` | rows one transaction expires |

These measure different things and must not be collapsed.

The **batch size** caps the *work per invocation*. A sweep is a background job competing
for the same connection pool as live checkout traffic; an unbounded `SELECT` after a
weekend of abandoned carts is a self-inflicted incident. Capping it means a backlog drains
across successive invocations instead of in one pass. It is a **ceiling**: a caller may ask
for fewer rows (the value is clamped into `[1, RESERVATION_SWEEP_BATCH_SIZE]`), never more.

The **transaction size** caps the *lock hold time*. Every row the sweep expires holds an
exclusive row lock on its `stock_level` and its `reservation` until the transaction commits.
Concurrent checkout writes — Add to Cart's Reserve, Place's Allocate — touch those same
rows. A transaction of 25 rows commits in milliseconds; a transaction of 200 holds locks
five to ten times longer, and every shopper whose variant is in that batch waits.

### Why a single 200-row transaction is the wrong shape

It is simpler. It is also wrong twice over.

First, it welds the two bounds together. Raising the batch size to drain a backlog faster
would directly degrade checkout latency, so the operator has one knob that trades a problem
for a different problem.

Second — and worse — **the whole transaction is the retry unit.** The sweep writes under a
version-checked compare-and-swap; a single row losing its race to a concurrent Remove Line
raises `StockWriteConflictError` and forces the *entire* transaction to retry from a fresh
read. With 200 rows in flight the probability that at least one conflicts approaches
certainty under load, and the sweep can burn its whole `OCC_RETRY_ATTEMPTS` budget without
ever converging. With 25, a conflict costs 25 rows of rework, and the next chunk starts
clean.

So: `for each chunk of TRANSACTION_SIZE ids → withInvalidation(runWithStockWriteRetry(...))`.
The `withInvalidation` wrapping is **per chunk**, not around the whole sweep. That is
[ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md)'s contract taken literally:
the cache is invalidated *after the commit that changed the data*. One wrapper around
everything would leave chunk 1's commit visible in MySQL while Redis still served chunk 1's
pre-commit `available` for as long as chunks 2..N took to run.

## 4. The race, settled without a lock

Two writers want the same hold: the sweep (its TTL elapsed) and a shopper who returns to the
tab and removes the line, driving `ReleaseReservationUseCase`. Both intend to return the same
`quantity` to `available`. If both succeed, `quantity_reserved` is decremented **twice** —
the counter now understates reality, and the system will oversell.

The sweep takes **no** pessimistic lock. Two mechanisms already in the codebase settle it.

### Interleaving A — Remove Line commits first

```
sweep:   listExpiredActive(now)  → [hold H]          (advisory, no transaction)
remove:                            BEGIN; H.release(); level.releaseReserved(3);
                                   persist(level, expectedVersion=7); save(H); COMMIT
sweep:   BEGIN; findById(H, scope) → status = 'released'
         → skip, count it, no throw
         COMMIT (nothing written)
```

The scan's rows are **candidates only**. Each is re-read by id *inside* the transaction, and
`status !== 'active'` is a silent, counted skip — not an error. This is deliberate and it is
where the sweep differs from Release: Release's pre-transaction read is a client-facing 404 /
409 check ("you asked me to release hold X" deserves an answer), whereas the sweep asked for
nothing in particular and a row that moved under it is not a fault. The same skip absorbs a
row an `AllocateStockUseCase` committed, a row a *second sweeper instance* already expired,
and — via a separate guard — a row whose `expiresAt` a concurrent `refresh(...)` pushed past
this invocation's `now`.

### Interleaving B — the sweep gets there first, then loses the CAS

```
sweep:   BEGIN; findById(H) → active, expired
         level = findStockLevel(...)     → version 7
         expectedVersion = 7
         level.releaseReserved(3); H.expire()
remove:                                  BEGIN; ...; persist(level, 7) → version 8; COMMIT
sweep:   persist(level, expectedVersion=7)
         → UPDATE ... WHERE version = 7 matches 0 rows
         → StockWriteConflictError; ROLLBACK
         runWithStockWriteRetry: BEGIN (attempt 2)
         findById(H, scope) → status = 'released'   ← the winner's post-state
         → skip. expired: 0, skipped: 1. No ledger row, no event.
```

The `expectedVersion` is captured **before** `releaseReserved` bumps it. The persist is
`UPDATE stock_level SET ..., version = version + 1 WHERE id = ? AND version = ?`; zero rows
affected means a concurrent writer advanced the row, and `runWithStockWriteRetry` re-opens a
fresh transaction and re-runs the **whole chunk** against the new snapshot. Every row is
re-read, so rows the winner already handled fall into the interleaving-A skip.

Note also that the ledger append runs **after** the compare-and-swap. A losing attempt
throws before writing any `stock_movement` row, so a conflicting retry never leaves an
orphaned audit row behind.

**The invariant, named:** `quantity_reserved` is decremented **exactly once per hold**.
Multiple sweeper instances racing on one row are safe — the loser observes the post-state and
treats it as a no-op. Neither correctness nor liveness depends on there being only one
sweeper.

## 5. `reasonCode: 'expired'`

`ReservationReleaseReason` (`libs/contracts/inventory/reservation/reservation-release.payload.ts`)
already enumerates:

```ts
type ReservationReleaseReason = 'cart-removed' | 'expired' | 'order-cancelled' | 'manual';
```

`ReleaseReservationUseCase` writes the reason verbatim into `stock_movement.reason_code`, and
`StockReleasedEvent.reason` is typed by the same union. The sweep writes `'expired'` — the
member that was put there for it.

A bespoke `'reservation-ttl-expired'` would have been the only `reason_code` in the table with
no corresponding union member: an operator reading the ledger would find two spellings of one
concept, and a consumer switching on `StockReleasedEvent.reason` would need a case the type
system does not know about. `type = 'release'` together with `reason_code = 'expired'` is
already unambiguous — nothing else releases a hold for TTL elapse.

Each expired hold appends exactly one **strictly negative** `release` movement:
`quantity = -hold.quantity` (the sign is fixed per type by `StockMovement.requireSignForType`),
`referenceType = 'cart'`, `referenceId = cartId`, and `actorId` = the staff id when a human
triggered the sweep, `null` for an unattended tick. This is *audit, not balance*: the counter
never moves without a row that explains why.

## 6. Per-row emission

Each expired hold emits its own `inventory.stock.released` (carrying `cartId` and
`reservationId`) plus its own `inventory.stock-movement.recorded`. Both fire post-commit and
best-effort — a publish failure is `warn`-logged and swallowed, because the counters are
already durable and failing here would misreport a committed write.

Coalescing per `(variantId, stockLocationId)` — one summed event per level — was considered
and rejected. It would have to sum the quantities and null out `cartId` / `reservationId`,
which is the entire correlation value the event carries and which the ledger already records
per hold. And `inventory.stock.released` is a **reserved surface**: it has no business
consumer, only the `#`-bound event-store firehose
([ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)). There is nobody for whom
fewer, coarser events would be an improvement — only a future consumer, for whom the sweep's
events being shape-identical to `ReleaseReservationUseCase`'s is strictly better.

## 7. Configuration

Both knobs are Joi-validated in `libs/config/config-module.config.ts` with defaults, so a
missing var never fails boot (the `RESERVATION_TTL_MINUTES` precedent), and both reach the
use case through `ConfigService`-backed **value-provider DI tokens** declared in
`application/ports/reservation-sweep.tokens.ts` and bound in `infrastructure/stock.module.ts`:

| Env var | Joi | Token |
| --- | --- | --- |
| `RESERVATION_SWEEP_BATCH_SIZE` | `integer().min(1).default(200)` | `RESERVATION_SWEEP_BATCH_SIZE` |
| `RESERVATION_SWEEP_TRANSACTION_SIZE` | `integer().min(1).default(25)` | `RESERVATION_SWEEP_TRANSACTION_SIZE` |

A use case never reads `process.env` and never injects `ConfigService`
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md); the same rule that
carries `OCC_RETRY_ATTEMPTS` and `RESERVATION_TTL_MINUTES`). The values also appear in
`.env.example`, `.env.local`, and the inventory service block of `docker-compose.yml`.

`execute()` returns `{ scanned, expired, skipped, durationMs }`, with
`scanned === expired + skipped` true by construction. An empty scan — the steady state —
returns early at `debug`; an invocation that expired anything logs one `info` line carrying
`{ correlationId, scanned, expired, skipped, batches, durationMs }`.

The `correlationId` is minted per invocation with `randomUUID()` when the caller supplies
none: a background tick has no request scope. It is logged as an **inline field**;
`PinoLogger.assign()` is request-scoped and throws outside one.

## 8. What is deliberately not here

- **No retention or purge of `expired` rows.** The row survives its expiry, and that is
  load-bearing: the all-statuses UNIQUE triple `(cart_id, variant_id, stock_location_id)`
  means a shopper who re-adds the line `reactivate`s the same row rather than duplicating it.
  Rows accumulate with abandoned carts and nothing prunes them. This is an accepted open gap,
  recorded rather than papered over with an env var nothing reads.
- **No schedule in this file.** The cadence — and the `@nestjs/schedule` import that carries
  it — belongs in `infrastructure/`, never in `application/`, the notification
  `DeliveryRetryScheduler` and retail `IdempotencyPurgeScheduler` precedent. See
  [`02-sweeper-cron-and-emit-granularity.md`](02-sweeper-cron-and-emit-granularity.md).
- **No operator endpoint.** No RPC routing key, no gateway route: the timer is the only
  caller.
- **No lock.** Stated as a design commitment, not an omission: see §4.
- **No migration.** The index the scan needs already exists.

**The sweep does not guard its own throws.** An exhausted `OCC_RETRY_ATTEMPTS` budget surfaces
`STOCK_WRITE_CONFLICT` and aborts the invocation; chunks committed before the failing one stay
committed. Whoever drives the sweep owns the `try/catch` that keeps a thrown tick from killing
the loop — the scheduler does exactly that.

## Cross-links

- [ADR-038](../../adr/038-reservation-ttl-sweep-and-bounded-batches.md) — this capability's
  decision record.
- [ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) — the
  `Reservation` aggregate, `expire()`, and the `stock_movement` *audit, not balance* ledger.
- [ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) — `withInvalidation` and
  the type-enforced post-commit ordering the per-chunk wrapping honours.
- [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) — `OCC_RETRY_ATTEMPTS`
  and the bounded optimistic write protocol the sweep reuses unchanged.
