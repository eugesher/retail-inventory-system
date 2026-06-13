# Receive and Adjust now write StockMovement rows

This note explains a write-path enrichment of two operations that already
shipped: **Receive Stock** and **Adjust Stock**. Each now appends one immutable
`stock_movement` audit row — a `receipt` for Receive, a signed `adjustment` for
Adjust — **inside the same transaction** as the counter write, and announces it
with an `inventory.stock-movement.recorded` event after commit. No new endpoint,
RPC, routing key, contract, or migration: the operations behave identically on
their HTTP/RPC surface; they just leave an audit trail behind them now. It
assumes only the repository as it stands.

Related decisions:
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
(every counter-changing operation leaves a typed ledger row; the
recorded-on-every-insert event),
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md) (running
totals stay the balance authority — the ledger is audit, not the source of
truth),
[ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) (post-commit
cache invalidation). The ledger record itself — the `StockMovement` domain
record, the `stock_movement` table, and the append-only repository port — is
documented in
[03-stock-movement-typed-ledger.md](03-stock-movement-typed-ledger.md); the
shared optimistic write protocol these operations run inside is documented in
[04-no-oversell-invariant-and-occ.md](04-no-oversell-invariant-and-occ.md).

## What changed

Before this change, Receive and Adjust moved the `quantityOnHand` counter and
emitted their reserved-surface events (`inventory.stock.received` /
`inventory.stock.adjusted`), but wrote **nothing** to the audit ledger — the
`reasonCode` on an adjustment lived only in the request, the event payload, and
the logs. The ledger existed (it had been built with the Reserve/Release
capability, where Release was its first writer), but Receive and Adjust were not
yet wired to it.

Now:

- **Receive** appends one `receipt` movement with a **positive** `quantity`
  equal to the received amount, `reasonCode = null`, no polymorphic reference,
  and `actorId` = the receiving staff user.
- **Adjust** appends one `adjustment` movement with the **signed** `quantityDelta`
  (an `adjustment` is the one movement type that accepts either sign, as long as
  it is non-zero), `reasonCode` = the mandatory operator reason, and `actorId` =
  the adjusting staff user.

Both operations then emit `inventory.stock-movement.recorded` after the commit,
alongside their existing events. For Adjust that makes **three** independent
post-commit emits — adjusted, the maybe-low alert, and movement-recorded — each
best-effort and each swallowing its own failure.

## Why the append lives inside the counter transaction

The counter write and the audit row are **one unit of work**. The shared mutator
`applyOnHandChange` (in `application/use-cases/stock-mutation.ts`) runs:

```
withInvalidation(                              // ADR-023: invalidate AFTER commit
  runWithStockWriteRetry(                       // bounded optimistic retry
    transaction(                                // one fresh tx per attempt
      read StockLevel (capture version)
        → changeOnHand(delta)                   // domain mutate, rejects below zero
          → persistStockLevelChange(level, expectedVersion)   // CAS UPDATE
            → movementRepository.append(buildMovement(saved))  // ledger row, SAME scope
    )
  ),
  resolveItems,                                 // → the (variantId, stockLocationId) to wipe
)
```

The append joins the same `ITransactionScope` as the persist, so the counter and
its audit record commit or roll back together. Two properties fall out of the
**ordering** — append *after* the version-checked persist:

- **No orphaned ledger rows on a lost race.** `persistStockLevelChange` is a
  compare-and-swap (`UPDATE … WHERE id = ? AND version = ?`). When a concurrent
  writer advanced the row first, the UPDATE matches nothing and the repository
  throws `StockWriteConflictError` — *before* the append line is ever reached. A
  losing attempt therefore never writes a movement; only the winning attempt
  does.
- **Exactly one row per successful mutation.** `runWithStockWriteRetry` re-runs
  the *whole* attempt from a fresh read on a conflict (up to
  `MAX_WRITE_ATTEMPTS = 5`). Because the append sits past the throwing persist,
  retries cost nothing in the ledger: a Receive that took three attempts to win
  the optimistic race still appends one `receipt`, never three. A below-zero
  Adjust throws `STOCK_RESULT_NEGATIVE` even earlier (in `changeOnHand`, before
  the persist), so it writes neither a counter change nor a movement.

The alternative — appending the movement in a *separate* transaction after the
counter commits — was rejected: a crash between the two commits would leave a
counter change with no audit trail (or, in the other order, an audit row for a
change that never happened). Inside one transaction there is no such window.

### The helper change, kept minimal

`applyOnHandChange` gained an optional `buildMovement?: (saved: StockLevel) =>
StockMovement` factory and now returns `{ level, movement }` instead of the bare
`StockLevel` (so the use case can emit the recorded event post-commit without
re-querying — the appended row already carries its DB-assigned id). The factory
is **optional**: a caller that only moves a counter omits it and gets `movement:
null`, so the one place the write protocol lives stays the one place — there is
no parallel copy for "with a ledger row" vs "without". The reserve-side callers
(Reserve / Release / Allocate / Cancel) use the lower-level
`runWithStockWriteRetry` directly and are entirely unaffected.

## Why this was deferred until the ledger existed

The ledger is a cross-cutting record shared by every counter-moving operation:
the `StockMovement` domain record with its per-type sign rule, the
`stock_movement` table, the append-only `STOCK_MOVEMENT_REPOSITORY` port (which
deliberately exposes no `save`/`update`/`delete`), and the
`publishStockMovementRecorded` publisher method all had to exist first. They
landed with the reservation capability, where **Release** was the ledger's first
writer. Wiring Receive and Adjust before that infrastructure existed would have
meant building the ledger twice, or building a throwaway shim. Sequencing the
write-path enrichment after the ledger keeps each piece built once.

## Actor attribution

`actorId` is the identity of the staff user who performed the operation. It is
folded in at the HTTP edge from `@CurrentUser().id` in the gateway controller,
carried on the `IStockReceivePayload` / `IStockAdjustPayload` RPC payloads
(both already had the field), and written onto the ledger row. A **null**
`actorId` means **system** — an operation with no authenticated human behind it
(for example a future automated reconciliation job, or a direct RMQ caller that
omits the field). Both operations default a missing `actorId` to `null` rather
than inventing a placeholder, so "system" and "a specific staff user" stay
distinguishable in the audit trail.

## The running totals stay the balance authority

Appending these rows does **not** make the ledger the source of truth for stock
on hand. Per ADR-027 the maintained `StockLevel` counters remain authoritative
and `available` is a pure projection of them; the movement rows are an immutable
explanation of *why* a counter changed, never a thing summed to reconstruct a
balance. This is why the existing Receive/Adjust end-to-end tests — which assert
the returned `StockLevelView` and the HTTP status codes — stay green untouched:
the audit row is written in the same transaction but is never read back through
the availability path. (An end-to-end test that asserts the rows themselves
arrives with the audit-read capability, which exposes a query surface over the
ledger.)
