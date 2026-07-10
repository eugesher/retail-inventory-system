# ADR-038: Reservation TTL sweep in bounded batches

- **Date**: 2026-07-09
- **Status**: Accepted

---

## Context

[ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) introduced the
`Reservation` aggregate: a TTL-bounded, cart-scoped hold on stock. While a hold is
`active`, its `quantity` is counted into `StockLevel.quantityReserved`, and `available =
onHand − allocated − reserved` therefore drops. That is the whole point — it is what stops
two carts racing for the last unit.

The aggregate shipped with an `expire()` mutator (`active → expired`) and an
`isExpired(now)` predicate, **and no caller**. Expiry is a wall-clock fact, not a stored
transition, so nothing observes it: a hold whose cart was abandoned — never refreshed,
never removed, never converted to an order — keeps `quantity_reserved` elevated
**forever**. The units it holds are unsellable and unreclaimable. A shopper who abandons a
cart holding the last three units of a variant takes those three units out of the sellable
inventory permanently.

Three paths return a hold to `available` today: a cart Remove Line **releases** it, Place
**allocates** it (after which only a cancel-allocation frees it), and an operator
**manually releases** it by id. All three require someone to act. Nothing acts on a
stranded hold.

The `reservation` table already carries `IDX_RESERVATION_STATUS_EXPIRES_AT (status,
expires_at)`, added in the create-table migration precisely for the scan this ADR decides.
Both `stock_level` and `reservation` already carry a `version` column, and
[ADR-036](036-idempotency-key-store-and-enforced-occ.md) already made the retry budget for
version-checked writes an injected `OCC_RETRY_ATTEMPTS` knob.

This ADR records the **whole** reservation-sweep capability in one document; the code lands
across several sessions (the [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
/ [ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) /
[ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md) precedent, where one ADR
decides a multi-session build).

## Decision

### 1. A background sweep is the reclaim mechanism

A `SweepExpiredReservationsUseCase` in the inventory `stock` module scans for `active`
holds whose TTL has elapsed and expires them: it returns the held units to `available`,
appends the ledger row that explains why, and announces the release. This closes the loop
ADR-030 left open.

The scan is a new — and the **only** new — method on `IReservationRepositoryPort`:

```
listExpiredActive(now, limit, scope?)
  → WHERE status = 'active' AND expires_at < :now
    ORDER BY expires_at ASC, id ASC
    LIMIT :limit
```

The `<` is **strict**, matching `Reservation.isExpired(now)`: a hold whose `expiresAt`
equals `now` is not yet expired. `ORDER BY expires_at ASC` makes a capped sweep reclaim the
longest-stranded holds first; the `id` tiebreaker totalises the order, so a repeated scan
over an unchanged table returns the same page. `IDX_RESERVATION_STATUS_EXPIRES_AT` serves
it: the composite narrows to a status before ranging on the timestamp.

`now` is captured **once** per invocation and threaded into every comparison — the scan
predicate, the in-transaction `isExpired` re-check — so a long sweep can never expire a
hold that was still live when the sweep began.

### 2. Concurrency is settled by the existing optimistic protocol, not a lock

The sweep takes **no** pessimistic lock. Two mechanisms already in the codebase settle
every race:

- **A `status = 'active'` re-read precondition inside the transaction.** The scan's rows
  are *candidates only*. Each is re-read by id under the transaction scope; a row that is
  no longer `active`, or whose `expiresAt` was pushed past this invocation's `now` by a
  concurrent `refresh(...)`, is **silently skipped and counted**, never an error. A row
  that has vanished is likewise skipped: rows are never deleted, but a background sweep
  must not crash on one that is.
- **The version-checked compare-and-swap on `StockLevel`**, bounded by `OCC_RETRY_ATTEMPTS`
  (ADR-036). A lost CAS raises `StockWriteConflictError`; `runWithStockWriteRetry` re-opens
  a fresh transaction and **the whole chunk is re-read from the new snapshot**. Rows the
  winning writer already handled fall into the `status !== 'active'` skip.

Together these give the invariant: **`quantity_reserved` is decremented exactly once per
hold**. Multiple sweeper instances racing on one row are safe — the loser observes the
post-state and treats it as a no-op.

### 3. Two bounds, two jobs

| Knob | Default | Bounds |
| --- | --- | --- |
| `RESERVATION_SWEEP_BATCH_SIZE` | `200` | rows one invocation scans and expires — the **work** per tick |
| `RESERVATION_SWEEP_TRANSACTION_SIZE` | `25` | rows one transaction expires — the **lock hold time** |

They are orthogonal and must not be collapsed into one number. The batch size lets a
backlog drain across successive sweeps rather than in one unbounded pass. The transaction
size keeps the row locks the sweep holds short, so the concurrent checkout writes it races
with — Add to Cart's Reserve, Place's Allocate — do not queue behind it.

Both are `ConfigService`-backed value-provider DI tokens
(`RESERVATION_SWEEP_BATCH_SIZE` / `RESERVATION_SWEEP_TRANSACTION_SIZE`), never constants
and never `process.env` inside the use case ([ADR-017](017-architecture-lint-via-eslint-boundaries.md),
the `RESERVATION_TTL_MINUTES` / `OCC_RETRY_ATTEMPTS` precedent). Both are Joi-defaulted, so
a missing var never fails boot.

A caller may pass a smaller `batchSize`; a **finite number** is clamped into
`[1, RESERVATION_SWEEP_BATCH_SIZE]`. **The configured value is a ceiling an override cannot
raise.**

Anything that is *not* a finite number means "no override" and falls back to the ceiling —
not to the floor. `undefined` is the scheduled tick. `null` reaches the use case through the
gateway, because `@IsOptional()` skips its validators for `null` as well as `undefined`. A
string or an object reaches it through a direct RPC, which no pipe guards. Reading "absent"
as `=== undefined` would have made `null` clamp to `1` — a one-row sweep reporting success —
and a string clamp to `NaN`, which reaches `find({ take: NaN })` as a TypeORM error.

### 4. Cache invalidation is per chunk, through `withInvalidation`

Each chunk's transaction is wrapped in its own `IStockCachePort.withInvalidation(...)`
call, honouring [ADR-023](023-cache-invalidate-post-commit-by-type.md)'s type-enforced
post-commit ordering. One `withInvalidation` around the *whole* sweep would leave earlier
chunks' commits visible in MySQL while the cache still served their pre-commit `available`.

### 5. `reasonCode` reuses the existing `'expired'` value

`ReservationReleaseReason` already enumerates `'cart-removed' | 'expired' |
'order-cancelled' | 'manual'`. `ReleaseReservationUseCase` writes the reason verbatim into
`stock_movement.reason_code`, and `StockReleasedEvent.reason` is typed by the same union.
The sweep writes `'expired'`. A bespoke `'reservation-ttl-expired'` would be the only
`reason_code` in the table with no corresponding union member, and `type = 'release'` plus
`reason_code = 'expired'` is already unambiguous.

Each expired hold appends exactly one **strictly negative** `release` movement
(`quantity = -hold.quantity`, `referenceType = 'cart'`, `referenceId = cartId`,
`actorId` = the staff id for an operator-triggered sweep, `null` for an unattended one).
This is what upholds ADR-030's *audit, not balance*: the counter never moves without a row
explaining why.

### 6. Events are emitted per reservation row

One `inventory.stock.released` per expired hold, carrying its `cartId` and `reservationId`,
plus one `inventory.stock-movement.recorded` per ledger row. Both post-commit and
best-effort ([ADR-020](020-rabbitmq-as-inter-service-bus.md)): a publish failure is
warn-logged and swallowed, because the counters are already durable.

Coalescing per `(variantId, stockLocationId)` is **explicitly rejected**. It would have to
sum quantities and null the `cartId` / `reservationId` fields — the entire correlation
value the event carries, and which the ledger already records per hold. `inventory.stock.released`
is a reserved surface: it has no business consumer, only the event-store firehose
([ADR-035](035-event-store-firehose-topic-exchange.md)), so there is no consumer for whom
fewer, coarser events would be an improvement. Per-row emission also makes the sweep's
events indistinguishable in shape from `ReleaseReservationUseCase`'s — which is exactly
what a downstream consumer would want if one ever binds.

### 7. `expired` rows are retained; no purge policy is decided here

An expired reservation row survives. It keeps the all-statuses UNIQUE triple
`(cart_id, variant_id, stock_location_id)` addressable, so a shopper who re-adds the line
`reactivate`s the same row rather than duplicating it. Retention or purge of `expired` rows
is **an accepted open gap**, deliberately not decided here rather than shipped as an env
var nothing reads (the `RETENTION_DELIVERY_DAYS` anti-precedent).

## Alternatives Considered

- **`SELECT … FOR UPDATE` over the candidate set (pessimistic locking).** Rejected. The
  optimistic `version` token already exists on both `stock_level` and `reservation` and is
  already enforced. A row lock adds deadlock surface against the very checkout path the
  sweep is supposed to stay out of — and against a lock ordering (level-then-hold vs
  hold-then-level) the write paths do not currently agree on. The re-read precondition
  gives the same correctness for none of the contention.

- **One transaction for the whole batch.** Rejected, though simpler. Lock hold time would
  scale with batch size, so raising the batch size to drain a backlog faster would
  directly degrade checkout latency — the two knobs would fight. Worse, a single
  conflicting row would force the *entire* batch to retry, and under sustained contention
  a large batch might never converge inside `OCC_RETRY_ATTEMPTS`.

- **A MySQL event scheduler, or a raw `UPDATE reservation SET status='expired' WHERE
  expires_at < NOW()`.** Rejected. It moves the status — and would have to move
  `quantity_reserved` — without appending the ledger row and without emitting the event,
  breaking ADR-030's *audit, not balance* invariant. It also runs entirely outside the
  application, so ADR-023's post-commit cache invalidation never fires and `available`
  stays stale in Redis until the TTL safety net expires. Business rules in the database are
  invisible to the boundary tests that guard them.

- **Expiring lazily on read — checking `expiresAt` inside `QueryAvailability`.** Rejected.
  It turns a cached read path into a write path (with a transaction, a ledger append, and
  an invalidation of the cache the read just populated), and it never reclaims a variant
  nobody queries — precisely the long tail where stranded holds accumulate.

- **Coalesced per-level emission.** Rejected — see §6.

## Consequences

- **`expired` rows accumulate.** The table grows with abandoned carts and nothing prunes
  it. The indexes serve the sweep's scan regardless of how many `expired` rows sit beside
  the `active` ones (the composite narrows by status first), so this is a storage cost, not
  a latency one — until it is not. Named as an open gap, not solved here.

- **A sweep interval longer than the TTL widens the reclaim window.** Between a hold's
  `expiresAt` and the sweep that observes it, `available` **understates** reality: the
  units are held by a hold nobody will use. The system stays oversell-safe (it under-sells,
  never over-sells), but the "only 1 left!" signal is pessimistic for up to one sweep
  interval past the TTL. Whatever drives the sweep should tick well inside
  `RESERVATION_TTL_MINUTES`.

- **A swept release is not traceable to any customer request.** The `correlationId` is
  minted per invocation, because a background tick has no request scope. Every row expired
  by one invocation shares that id, and it will not join any customer's trace. This is
  inherent to the reclaim being unattended; the `cartId` and `reservationId` on the event
  and the ledger row are what connect the release back to the abandoned cart.

- **The use case does not guard its own throws.** An exhausted retry budget surfaces
  `STOCK_WRITE_CONFLICT` and aborts the invocation; chunks after the failing one are not
  attempted (the ones before it are committed). Whatever drives the sweep owns the decision
  to swallow that — the `IdempotencyPurgeScheduler` try/catch precedent.

## References

- [ADR-027](027-stocklevel-running-totals-and-stocklocation.md) — `StockLevel` running
  totals, `available` as a pure getter, and the `version` column this sweep's CAS uses.
- [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) — the
  `Reservation` aggregate, `expire()`, the `stock_movement` ledger, and *audit, not
  balance*.
- [ADR-023](023-cache-invalidate-post-commit-by-type.md) — `withInvalidation` and the
  type-enforced post-commit ordering the per-chunk wrapping honours.
- [ADR-036](036-idempotency-key-store-and-enforced-occ.md) — `OCC_RETRY_ATTEMPTS`, the
  bounded optimistic write protocol the sweep reuses unchanged.
- [ADR-035](035-event-store-firehose-topic-exchange.md) — why `inventory.stock.released` is
  a reserved surface with no business consumer.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — why the two knobs arrive as
  DI tokens rather than a `ConfigService` read inside `application/`.
