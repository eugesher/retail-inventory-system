# No oversell under retry — the end-to-end concurrency guarantees

The two headline guarantees of this capability are only meaningful if they survive real
concurrency: an **idempotent** write must collapse a retry to one effect, and an
**optimistically concurrent** write must let exactly one racer win without ever violating an
invariant. This document describes the end-to-end suites that prove those properties through
the API gateway — the concurrent-demand tests, the high-fan-out convergence test, and the
idempotent-replay oracle — and explains why a bounded *retry* is what makes the no-oversell
invariant hold rather than what threatens it.

Related decisions:
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) (the bounded
optimistic write protocol and the reservation hold),
[ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) (the idempotency-key store,
the enforced OCC, and the configurable retry budget), and
[ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) (the `domain_event` firehose
row that serves as the "exactly one event" oracle). See also the sibling docs
[03 — OCC on `StockLevel`/`Reservation`](./03-occ-on-stocklevel-reservation.md),
[04 — OCC on Cart/Order/Fulfillment/ReturnRequest](./04-occ-on-cart-order-fulfillment-returnrequest.md),
and [06 — replay does not republish events](./06-replay-does-not-republish-events.md).

## The canonical guarantee

> Under concurrent demand on the same variant, the total number of successful allocations
> never exceeds the available stock — even when writers retry.

`available = quantityOnHand − quantityAllocated − quantityReserved` is a running total on the
`stock_level` row, and it must never go negative. When many buyers race for a scarce variant,
the naive failure mode is a lost update: two writers both read `available = 1`, both decide
their reserve is valid, and both write back — selling the same unit twice. The bounded
optimistic write protocol (ADR-030) closes that hole: every counter-changing write is a
version-checked compare-and-swap (`UPDATE … SET version = version + 1 WHERE id = ? AND
version = :expected`), and a lost CAS is retried a bounded number of times before surfacing a
`409`.

## Why retry does not break it

The subtlety is that *retry* — the mechanism that keeps the system live under contention —
could naively be the very thing that oversells: if a retry replayed a stale decision, it would
allocate against a snapshot that no longer holds. It does not, because **each attempt is a
fresh unit of work**:

1. Every retry opens a **new transaction** and **re-reads** the row, capturing the *current*
   `version`.
2. The domain invariant is re-checked on the freshly read totals — `StockLevel.reserve`
   throws `OUT_OF_STOCK` the instant the ask exceeds the now-current `available`.
3. The write is a CAS against the version just read, so it commits only if no one else moved
   the row in between.

So a retry never carries a decision across snapshots. A writer that lost the race either
re-reads and finds stock still available (and legitimately succeeds on the new snapshot) or
re-reads and finds it exhausted (and fails with `OUT_OF_STOCK`). It can never double-allocate.
The retry budget is the injected `OCC_RETRY_ATTEMPTS` (default **5**); the server absorbs most
contention within that budget, and a client that still sees a residual `409` simply refetches
and retries — the same contract a human refreshing a page would follow.

## The concurrent-place test

`test/concurrent-place-order.e2e-spec.ts` provisions one variant to exactly **5** on-hand and
turns **10** distinct customers loose on it at once. Each racer runs a full checkout — add a
line (which reserves through the CAS), then place — and the ten checkouts are dispatched in a
single `Promise.all` so they truly contend on the one `stock_level` row.

The suite is **winner-agnostic**: it never assumes which five win, it sums the outcomes and
asserts exact counts:

- exactly **5** checkouts place an order (`201`), and the other **5** get
  `409 INVENTORY_OUT_OF_STOCK` — total successful allocations equal available stock, never
  more;
- the final row reads on-hand `5` / allocated `5` / reserved `0` / available `0`, with no
  counter negative;
- the uncached `stock_movement` ledger holds exactly **5** `allocation` rows — one per placed
  order, each `−1` and referencing a *distinct* order id. No duplicate allocation survives the
  race, which is the ledger-level statement of "retry never double-allocates".

`test/concurrent-oversell.e2e-spec.ts` proves the same invariant from the opposite direction —
two carts racing for the *last* unit, and, in its third act, a single buyer firing **two
concurrent Place requests at one cart under one `Idempotency-Key`**. The cart-conversion CAS
(`markConverted WHERE status = 'active'`) lets only one request convert-and-allocate; the other
resolves to the same order without allocating, so the ledger again holds exactly **one**
`allocation` movement. The double-submit collapses to one effect.

## The 50-way receive test

`test/inventory-concurrency.e2e-spec.ts` isolates the write path from checkout. A fresh row is
seeded to a known non-zero baseline, then hit with **50** simultaneous Receive `+1` requests.
The assertion is exact: final on-hand `= seed + 50`.

That exactness *is* the observable proof that OCC retries did their job. Without the
version-checked CAS + bounded retry, 50 concurrent read-modify-writes would overwrite one
another and the final on-hand would fall short of `seed + 50`. Because every applied `+1` is
preserved, the final total can only be exact if each increment committed on a fresh snapshot —
i.e. if the losers of each CAS re-read and retried rather than clobbering the winner. The suite
corroborates this with the ledger: each committed write appends exactly one `receipt` movement
in the same transaction, so the 50-request burst leaves exactly **50** new `receipt` rows — a
lost update would have committed fewer. The default budget of 5 attempts, combined with the
client re-firing any residual `409`, is enough to converge this fan-out reliably.

## The idempotency oracle

Concurrency is not the only way a write can be attempted twice — a client retry (a dropped
response, an impatient refresh) sends the same logical operation again. The request-level
idempotency store (ADR-036) makes that a no-op, and the suites prove it *end-to-end* rather
than in isolation:

- `test/idempotency-place-order.e2e-spec.ts` fires two identical `POST /cart/:id/place` under
  one `Idempotency-Key`. Both responses carry the **same** `orderId`; exactly **one** order
  exists for the cart; the second response is `200` with `Idempotent-Replay: true` (a fresh
  place is `201`); and — the cross-service oracle — exactly **one** `retail.order.placed` row
  lands in the isolated `ris_eventstore.domain_event` firehose log, asserted by direct SQL
  keyed on `(event_type, aggregate_id)`. One logical place = one order = one event, because the
  replay short-circuits *before* the event publisher.
- `test/idempotency-different-body.e2e-spec.ts` reuses a key with a **different** body and gets
  `422 ORDER_IDEMPOTENCY_KEY_REUSED` before any side effect, plus the `400
  IDEMPOTENCY_KEY_REQUIRED` backstop when the header is absent.
- `test/idempotency-capture.e2e-spec.ts`, `test/idempotency-ship.e2e-spec.ts`, and
  `test/idempotency-refund.e2e-spec.ts` prove the replay is side-effect-free per operation: the
  capture leaves `capturedAt` unchanged (no second charge), the ship leaves exactly one `sale`
  movement (no second `commit-sale`) and one capture, and the refund leaves one `refund` row,
  an unchanged `refunded_amount_minor`, and — the audit-integrity oracle — exactly **one**
  `RefundIssued` row in `ris_eventstore.audit_log_entry`. The refund replay short-circuits
  before the always-audit money seam, so one logical refund is audited exactly once.

## The purge

The idempotency store is live-ephemeral: `find` never treats an expired row as absent, so a
scheduled sweep is the sole authority that reclaims rows past their `expires_at` horizon.
`test/idempotency-purge.e2e-spec.ts` resolves the real purge use case from the running service
and drives it through its explicit-`now` seam — it seeds an aged row and a far-future control
row, runs a purge at the current instant (deleting neither), then runs a purge at a *future*
instant past the aged row's horizon and asserts the aged row is gone while the control row
survives (the strict `expires_at < now` predicate). No system clock is touched and no 24-hour
TTL is waited out.

## Running the suites

All of the above run through the API gateway under `yarn test:e2e` (a full infra reload +
migrate + seed + run) or `yarn test:e2e:run` against already-running infra. Every concurrency
suite self-provisions its own disjoint fixture (its own product, variant, price, and received
stock), so they never touch the shared seeded variants and cannot interfere with one another —
the suites are hermetic and deterministic, asserting exact counts against DB-backed reads
rather than broker side effects or timing.
