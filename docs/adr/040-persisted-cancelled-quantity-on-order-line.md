# ADR-040: Persisting the cancelled quantity on `OrderLine`

- **Date**: 2026-07-10
- **Status**: Accepted

---

## Context

[ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) introduced **Cancel
Line** (staff `order:cancel`) as the narrow unwind beside Cancel Order: it cancels the
unshipped quantity of one `OrderLine` and releases just that slice of the stock
allocation, touching no money. It defined the cancellable amount as

> cancellable = ordered − already-shipped

and left the operation **stateless on the order**: the use case read the order, computed
the remainder, called `inventory.allocation.cancel`, and wrote nothing back. The comment in
`cancel-line.use-case.ts` said so explicitly, and drew the correct conclusion from a false
premise: with no local aggregate write there is no lost update, so no version-checked CAS
is needed (ADR-036).

The premise is false because the cancellation *is* state. Nothing recorded it, so the
remainder was recomputed from `ordered − alreadyFulfilled` on **every** call, and the same
units stayed cancellable forever. Four defects follow from the one omission:

1. **Unbounded over-release.** Cancel Line on the same line twice released the same units'
   allocation twice, decrementing `stock_level.quantity_allocated` below the truth. There
   was no guard anywhere: the domain had no cancelled count to check, and the use case's
   remainder never shrank. Repeated calls drove the counter arbitrarily negative. Because
   `quantity_allocated` is shared per `(variant, location)`, the deficit is not confined to
   the offending order — it eats other orders' allocations.
2. **Cancel Line then Cancel Order released the same units twice.** Cancel Order builds its
   release payload from each line's **ordered** quantity, on the reasoning that nothing has
   shipped so the place-time allocation is intact. A prior Cancel Line had already released
   part of it, so the second release freed units the order no longer held.
3. **Cancelled units remained shippable.** Create Fulfillment measured its own remainder
   against the same `ordered − alreadyFulfilled`, so a line whose units had been cancelled
   (and whose allocation inventory had already released) could still be put on a shipment.
4. **Cancelled units remained returnable.** The returns context's `RETURN_ORDER_READER`
   could only recognise a *whole* line cancelled, by reading `order_line.status =
   'cancelled'` — a status **nothing ever wrote** (`Order.cancel()` leaves the lines alone,
   and `markFulfillment` rejects `cancelled` outright). Its `cancelledQuantity` was
   therefore always `0`, a fact its own comment recorded as "a documented limitation".

The count cannot be derived. The stock movements that record each release live in the
inventory service's own ledger behind an RPC seam, unreachable from retail (ADR-017), and
`fulfillment` rows describe what shipped, not what was cancelled. The order is the only
place that can hold the fact.

## Decision

### 1. `order_line.cancelled_quantity` is the single source of truth

A new `INT NOT NULL DEFAULT 0` column, bounded by a CHECK constraint
(`0 ≤ cancelled_quantity ≤ quantity`) that mirrors the domain invariant. The default
backfills every existing row correctly: no prior code path ever cancelled a partial
quantity durably.

The money columns are **not** touched. `line_total_minor` stays the buyer's place-time
snapshot; a credit is still the refund capability's job (ADR-031, ADR-032). Cancelling
units changes what the order *owes*, not what it *cost*.

### 2. `activeQuantity = quantity − cancelledQuantity` is the quantity every rule measures

`OrderLine.activeQuantity` replaces the place-time `quantity` as the bound in every
downstream rule:

| Rule | Before | After |
| --- | --- | --- |
| Cancel Line's cancellable remainder | `ordered − alreadyFulfilled` | `activeQuantity − alreadyFulfilled` |
| Cancel Order's release payload | `ordered`, every line | `activeQuantity`, lines with `> 0` |
| Create Fulfillment's shippable remainder | `ordered − alreadyFulfilled` | `activeQuantity − alreadyFulfilled` |
| Ship's per-line "fully shipped" test | `shipped ≥ ordered` | `shipped ≥ activeQuantity` |
| Returns' returnable pool | `ordered − (status='cancelled' ? ordered : 0)` | `ordered − cancelled_quantity` |

Ship's order-axis roll-up **skips** a line with `activeQuantity === 0`: it is terminal at
`cancelled`, can never accumulate shipped units, and would otherwise hold the order's
fulfillment axis below `shipped` forever. (`markFulfillment` would also reject its status.)

Cancel Order **drops** such a line from its release payload and skips the RPC entirely when
no line has active units — inventory rejects a non-positive line quantity and an empty
`lines` array (`normalizeReservationLines`). The cancel itself still succeeds: the release
is post-commit and best-effort.

### 3. Cancelling the last active unit is terminal

`OrderLine.cancelQuantity` moves the line to `cancelled` once `activeQuantity` reaches 0.
This is the first writer of that enum member. It can only be reached with nothing fulfilled
(the caller cancels unshipped units only), so no fulfillment-progress status is overwritten.
A **partial** cancel leaves the fulfillment-progress status alone — the remaining units
still ship.

### 4. The mutation routes through the `Order` root, under version-checked OCC

`Order.cancelLineQuantity(orderLineId, units)` finds the line (raising the root's
`ORDER_LINE_NOT_FOUND`), delegates to `OrderLine.cancelQuantity`, and bumps the OCC token.
Cancel Line therefore **does** perform an aggregate write, and takes the same bounded
compare-and-swap every other order mutator takes (`runWithOrderWriteRetry`,
`OCC_RETRY_ATTEMPTS`, exhaustion → `409 VERSION_MISMATCH`). This **reverses ADR-031's
"no optimistic-concurrency guard" for this operation only** — that reasoning was sound
given a stateless Cancel Line and is void now. Without the CAS, two concurrent cancels
could each read `cancelled_quantity = 0` and both commit their own `+1`, losing one update
and reinstating the over-release the column exists to prevent.

The line's own bound (`units ≤ activeQuantity`) is retained inside `cancelQuantity` as a
last line of defence: the use case subtracts the fulfilled units the child entity cannot
see, but the child still refuses to cancel more than it has.

### 5. The local write commits before the allocation release

The order of operations becomes the Cancel Order posture: the version-checked write commits
**first**, then `inventory.allocation.cancel` runs post-commit with
retry-then-log-for-replay. A failed release now over-holds stock until manual intervention
(safe, and visible) instead of over-releasing it. Releasing first would reinstate the bug on
any rollback — a released slice with no committed count is exactly the pre-fix state.

## Alternatives Considered

**Derive the cancelled quantity from the stock ledger.** Rejected: `stock_movement` belongs
to the inventory service's database context and is reachable only over RPC. A retail
invariant may not depend on a synchronous cross-service read, and the ledger's `release`
rows do not distinguish a Cancel Line slice from a sweep or a cart removal by order line.

**Reuse `order_line.status = 'cancelled'` alone, with no count.** Rejected: it cannot
express a partial cancellation, which is the entire point of Cancel Line (a whole-line
cancel is Cancel Order's job for a single-line order). It also cannot be made idempotent
per-unit.

**Make Cancel Line idempotent on a request key instead.** Rejected: the idempotency-key
store (ADR-036) collapses a *retried* request; it does not stop two genuinely distinct
cancel requests from cancelling the same units. The defect is an accounting hole, not a
retry hole.

**Keep Cancel Line stateless and forbid a second call by checking the inventory allocation.**
Rejected: it makes a retail invariant depend on inventory's live counters, inverts the
ownership of the rule, and still races.

**Decrement `order_line.quantity` in place.** Rejected: `quantity` is a place-time snapshot
and the base of `line_total_minor`'s derivation, which the domain asserts on every read
(`ORDER_LINE_TOTAL_MISMATCH`). Mutating it would either corrupt the money invariant or
silently rewrite the buyer's contract.

## Consequences

- `order_line` grows a column, and `OrderLineView` grows a `cancelledQuantity` field — an
  additive wire change; clients that ignore it see the old shape.
- Cancel Line is now a **writing** operation: it opens a transaction, takes a CAS, and can
  surface `409 VERSION_MISMATCH` under contention. It remains eventless.
- `order_line.status = 'cancelled'` becomes reachable for the first time. Any read that
  switches on the line status must expect it; `markFulfillment` still rejects it, and the
  ship roll-up now skips such lines rather than calling into it.
- The returns pool shrinks correctly on a partial cancellation. The `RETURN_ORDER_READER`'s
  documented limitation is retired.
- The CHECK constraint means a corrupted count fails the write rather than reconstituting
  silently; the domain constructor rejects the same range on read.
- Cancel Line still emits no event, so the cancelled count reaches the event store only via
  the next `retail.order.*` event carrying an order view. Reconstructing "when was this unit
  cancelled" from the firehose alone remains impossible — an accepted gap, unchanged.

## References

- [ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) — introduced Cancel
  Line with the `ordered − already-shipped` remainder and no OCC. This ADR revises that
  remainder and that OCC stance; ADR-031 is otherwise unaffected.
- [ADR-036](036-idempotency-key-store-and-enforced-occ.md) — the bounded OCC protocol
  Cancel Line now joins.
- [ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md) — the returns reader whose
  `cancelledQuantity` now has a real source.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the isolation line that makes
  the inventory ledger unreachable from retail.
