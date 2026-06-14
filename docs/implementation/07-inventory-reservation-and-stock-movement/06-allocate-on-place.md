# Allocate Stock and Cancel Allocation

This note explains the two **order-side** inventory operations: **Allocate Stock**
(`inventory.reservation.allocate`), which converts a cart's holds into an order's
firm allocations at place-time, and **Cancel Allocation**
(`inventory.allocation.cancel`), which reverses an order's allocation. Together
they complete the reservation RPC surface inventory-side; the retail place
transaction wires onto allocate in a later capability. The note assumes only the
repository as it stands — no planning materials.

Related decisions: [ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
(the reservation hold lifecycle, the allocate/cancel policies, the
`allocation`/`release` movements, the `inventory.stock.allocated` event),
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md) (the
`StockLevel` running totals + the `version` optimistic-lock column),
[ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) (post-commit
cache invalidation), [ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)
(best-effort post-commit emits). The no-oversell write protocol these operations
reuse is documented in
[04-no-oversell-invariant-and-occ.md](04-no-oversell-invariant-and-occ.md); the
ledger they append to in
[03-stock-movement-typed-ledger.md](03-stock-movement-typed-ledger.md).

## 1. Reservation → committed (the common path)

When a shopper places an order, the cart's `active` holds become the order's
allocation in **one transaction**. The allocate request carries
`{ cartId, orderId, lines: { variantId, stockLocationId?, quantity }[] }`. Per
line the use case:

1. resolves the hold for the triple `(cartId, variantId, stockLocationId)` via
   `RESERVATION_REPOSITORY.findByKey` (any status);
2. for an `active` hold, `commit(now)`s it (`active → committed`, terminal); and
3. moves the `StockLevel` counter from `quantityReserved` to `quantityAllocated`.

The counter move has two shapes, decided by comparing the hold's quantity to the
order line's:

- **Exact match** (`reservation.quantity === line.quantity`) →
  `StockLevel.allocateFromReserved(q)`: a pure transfer, reserved down and
  allocated up by the same amount. `available` is unchanged, because both counters
  subtract from it — the unit was already held, it just changes *why* it is held.
- **Drift** (the two differ — a cart line quantity changed without a matching
  re-reserve) → `releaseReserved(reservation.quantity)` then
  `allocateDirect(line.quantity)`: return the held units to `available`, then take
  the order's quantity back out of `available`. This re-balances cleanly whether
  the order asks for more or fewer than was held, and the `allocateDirect` leg
  applies the no-oversell guard, so a *larger* ask that no longer fits is rejected
  (see §2).

Each line appends **one** `allocation` movement to the audit ledger:
`quantity = −line.quantity` (the fixed negative sign for `allocation`),
`referenceType = 'order'`, `referenceId = String(orderId)`, `reasonCode = null`,
`actorId = null`. After commit, the use case emits, best-effort and per line,
`inventory.stock.allocated` (carrying the committed `reservationId`) and
`inventory.stock-movement.recorded`.

## 2. The fallback, and why the payload carries the lines

Not every order line has a live hold. A line might never have reserved (a flow
that adds straight to an order), or its hold might have been released, expired, or
swept. For those the use case **falls back to a direct allocation against
`available`**: `StockLevel.allocateDirect(line.quantity)`, which raises
`quantityAllocated` only when `quantity ≤ available` and otherwise throws a typed
`OUT_OF_STOCK` carrying the live `available` in structured `details`. The result
entry's `reservationId` is `null` on this path — the signal that no hold backed
the line.

This is why the **lines ride the allocate payload** rather than the inventory
service reading retail's cart tables: the fallback must know *what* to allocate
(variant, location, quantity) even when there is no reservation row to read it
from, and inventory must not reach across the service boundary into retail's
schema (the opaque-`variantId` rule of ADR-027). The caller — the retail place
transaction — already holds the line data, so it sends it.

A **`committed`** hold for the triple is the one reservation state the fallback
does *not* treat as "no hold": it is rejected with `RESERVATION_INVALID_STATE`
(409), a double-allocate defense. Retail's idempotent re-place is cart-state
driven (a converted cart returns its existing order, ADR-028) and never calls
allocate twice, so this is belt-and-braces rather than a path the happy flow
takes.

## 3. The inline TTL policy: refresh-then-commit

A hold has a wall-clock `expiresAt`. There is no background sweeper yet, so a hold
can be **wall-clock-expired but still `active`** — its `quantity` is still sitting
in `quantityReserved`, occupying the counter. `Reservation.commit(now)` refuses an
expired hold (`RESERVATION_EXPIRED`), precisely so nothing silently converts a
lapsed hold.

The allocate use case resolves this inline: when an `active` hold `isExpired(now)`,
it first `refresh(reservation.quantity, now + RESERVATION_TTL_MINUTES)` — pushing
the TTL forward without changing the quantity — and *then* `commit(now)`.
Honoring a stale-but-still-held hold is **oversell-safe**: the units it represents
were never returned to `available`, so committing them takes nothing from anyone
else. The use case therefore never surfaces `RESERVATION_EXPIRED`.

What changes when a sweeper capability lands: a swept hold flips to `expired`
(status), its counter is returned to `available`, and the row stops being on the
common path — allocate would then see a non-`active` row and take the fallback
(re-checking `available`). The refresh-then-commit shortcut is a deliberate
stop-gap for the sweeper-less present, documented as such in ADR-030 §4.

## 4. Cancel Allocation

Cancel reverses an order's allocation. Its payload is
`{ orderId, lines, reason?, actorId? }`. Per line it loads the `StockLevel`,
`releaseAllocated(line.quantity)` (allocated down, `available` up), and appends
**one** `release` movement: `quantity = −line.quantity`, `referenceType = 'order'`,
`referenceId = String(orderId)`, `reasonCode = reason ?? 'order-cancelled'`,
`actorId = actorId ?? null`. It emits `inventory.stock.released` (with
`reason: 'order-cancelled'`, `cartId: null`, `reservationId: null` — an order
cancel releases by order, not by a single cart hold) and
`inventory.stock-movement.recorded`, best-effort post-commit.

**No reservation rows are touched.** By the time an order is cancelled its holds
are `committed` (or never existed); cancelling an order does not resurrect a cart
hold. The free-form `reason` lands in the movement's `reason_code` (an ops note
like `fraud-review` is allowed), while the typed event `reason` stays the
`order-cancelled` member of the release-reason union.

**Who calls it.** Two future callers: the order-cancel capability, and the
place-failure compensation in the retail-wiring capability (a rare post-allocate
commit failure best-effort cancels what allocate committed). The handler ships now
— callable over RMQ and fully tested — with **no in-repo caller**: a deliberate
reserved surface, not dead domain logic.

**Idempotency posture.** Cancel is **quantity-guarded, not state-tracked**. There
is no per-order "already cancelled" flag; an over-cancel (more than is allocated)
is a typed `STOCK_RESULT_NEGATIVE` (409) — the one allocated-counter rejection
that *is* user-reachable, so a Cancel RPC with a wrong quantity fails cleanly
rather than 500-ing or silently clamping. The RPC resolves `{ cancelled: n }`
(the line count), a small object rather than `void` so it serializes cleanly over
RMQ.

## 5. Atomicity and the failure surface

Both operations are **all-lines-or-nothing**. An order allocates in full or not at
all — a partial allocation must never commit, because the retail place transaction
invokes allocate *pre-commit* and a rejection rolls the entire place back (no
order, no cart conversion). The implementation guarantees this with a
**compute-then-write** structure inside each transactional attempt:

1. **Load** each distinct `(variantId, stockLocationId)` `StockLevel` exactly once,
   capturing its optimistic `version` *before* any mutation. Lines that share a
   level mutate the one in-memory instance, so the level persists with a single
   version-checked UPDATE (two persists with the same captured token would
   self-conflict).
2. **Compute** every line in memory — the hold decisions and counter moves. Every
   domain rejection (`OUT_OF_STOCK`, `RESERVATION_INVALID_STATE`,
   `STOCK_RESULT_NEGATIVE`) throws *here*, before a single write.
3. **Write** everything only after all lines validate: persist each distinct level
   once, save the committed holds, append the ledger rows.

Because no write happens until every line has been validated, a rejection on a
later line leaves *nothing* persisted for any earlier line — the same guarantee a
rolled-back transaction gives, and the property the unit specs assert with a
non-rolling-back fake transaction port.

The whole attempt runs inside the shared bounded optimistic write protocol
(`runWithStockWriteRetry`): a lost compare-and-swap on `persistStockLevelChange`
re-reads under a fresh snapshot and retries to a 5-attempt budget, then surfaces a
409 `STOCK_WRITE_CONFLICT`. That, in turn, is wrapped in
`stockCache.withInvalidation`, which fans the cache invalidation out **after** the
transaction commits (ADR-023), keyed on the distinct `(variantId, stockLocationId)`
pairs the operation touched. Domain rejections propagate immediately and are never
retried — only the optimistic conflict is.
