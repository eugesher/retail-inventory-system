# ADR-057: Cancel-Allocation needs an identity, because a quantity check is not idempotency

- **Date**: 2026-07-24
- **Status**: Accepted

---

## Context

Retail makes three cross-service calls **after** its own transaction has committed, all through the
one post-commit retry posture ([ADR-056](056-lifting-the-post-commit-retry-helper.md)):

| Call                                  | Trigger                                                                                               |
|---------------------------------------|-------------------------------------------------------------------------------------------------------|
| `inventory.stock.commit-sale`         | Ship ([ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md))                             |
| `inventory.stock.restock-from-return` | Inspect ([ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md))                             |
| `inventory.allocation.cancel`         | Cancel Order / Cancel Line ([ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) §4) |

The ordering is deliberate and it *requires* redelivery to be safe: the local write is durable
before the RPC goes out, precisely so a broker failure can retry without unwinding it. A retry fired
after a **timeout** travels alongside the original, because a timeout does not cancel an RPC.

Migration `1783872387242` closed that hole for the first two with `UC_STOCK_MOVEMENT_DEDUPE`, a
ledger UNIQUE keyed on the thing each operation is *about* — a `fulfillmentId`, a `returnRequestId`.
The third was left out, and the reason it was left out was never that it was safe. It was that
nobody looked: the shared helper's comment said *"Cancel-Allocation is idempotent-ish by shape
(`releaseAllocated` only rejects an over-release)"*, and three other comments repeated the claim in
their own words — the inventory controller's is the clearest:

> *"a replayed cancel simply **finds nothing left to release** and an over-cancel is refused."*

### That sentence is false, and its falseness is an oversell

`StockLevel.releaseAllocated(n)` refuses only to drive `quantity_allocated` below zero. And
`quantity_allocated` is a **counter several orders share**, per `(variant, location)` — not per
order. So:

1. Order A allocates 5 of variant V at location L → `quantity_allocated = 5`.
2. Cancel Order A releases 5 → `0`. Committed. Response lost; the helper retries.
3. Meanwhile order B allocates 5 of V at L → `quantity_allocated = 5`.
4. The retry arrives. `5 > 5` is false, so it **passes the guard** and releases → `0`.
5. **Order B's allocation is gone** while order B still exists.

`available = onHand − allocated − reserved` is now overstated by 5, and the system oversells — the
exact failure the whole no-oversell protocol exists to prevent. It is silent, because the running
totals are the balance authority and nothing reconciles them against the ledger (ADR-027 /
ADR-030 §2, *"audit not balance"*).

**"There is still enough to subtract" is not "this subtraction has not happened yet."** A quantity
check cannot distinguish them; only an identity can.

### Why it has no natural key, unlike its two siblings

This is the part that makes the fix non-obvious, and it is why extending the existing UNIQUE by one
`type` value would have been worse than doing nothing:

- A fulfillment ships once. A return is restocked once. Each names an operation that happens
  **exactly once**, so the entity id *is* the operation's identity.
- A cancellation names nothing of the kind. Cancel Line cancels a **quantity**, and
  [ADR-040](040-persisted-cancelled-quantity-on-order-line.md) made partial cancellation a
  first-class operation. Cancelling 2 units of a line today and 2 more tomorrow are two legitimate
  operations with **identical** `(order, line, variant, location)`.

So keying the dedupe on `reference_id` (the order) would reject the second **genuine** partial
cancellation as a replay, and — because the catch treats a duplicate as "already done" — drop its
release silently. That trades a rare race for a routine data-loss bug.

ADR-040 already closed the neighbouring hole and is worth not confusing with this one: it made a
retry of the whole **HTTP request** harmless, because `cancelled_quantity` is persisted and the
second request cancels zero units and sends no release at all. What it does not touch is a
redelivery of the **RPC** — the payload is already computed by then.

## Decision

**The caller mints the identity.** `IAllocationCancelPayload` gains a required `operationKey`.

### 1. Minted once per logical cancellation, before the retry loop

`releaseAllocationWithRetry` generates it — a `randomUUID()` — and hands the keyed payload to
`retryThenLogForReplay`. Every attempt in that loop, and every broker redelivery of the resulting
RPC, carries the same value; a genuinely separate cancellation gets a different one.

The placement is the decision, not the generation. Minting inside the loop, or inventory-side, would
defeat it entirely: a redelivery is only *recognisable* if the sender fixed its identity before it
started sending. The two one-shot compensations in `place-order.use-case.ts` (a failed place, a
declined authorization) call the gateway directly and mint their own for the same reason — nothing
retries them, but the broker can still redeliver.

It is a UUID rather than a derived key because, per the Context, no tuple of the operation's
parameters is unique.

### 2. Stored on the movement, deduped by the existing UNIQUE

Inventory writes it to a new `stock_movement.operation_key` column and
`UC_STOCK_MOVEMENT_DEDUPE`'s generated key gains a second arm:

```sql
WHEN type = 'release' AND operation_key IS NOT NULL
THEN CONCAT('release:', operation_key, ':', variant_id, ':', stock_location_id)
```

Three things about that arm are load-bearing:

- **`operation_key IS NOT NULL`, not `type = 'release'`.** Two other use cases write release rows —
  `ReleaseReservationUseCase` and `SweepExpiredReservationsUseCase` — and they must stay
  unconstrained. A NULL key yields a NULL dedupe key, and MySQL permits many NULLs under a UNIQUE
  (the `price.open_scope_key` technique, [ADR-026](026-price-append-only-ledger-and-tax-category.md),
  this being its fourth application).
- **`variant_id` + `stock_location_id` ride the key**, for the reason the first dedupe migration
  spells out: one cancellation writes one release row *per line*, all sharing the one key, so a key
  without them would reject every multi-line cancel — a certain outage traded for a rare race.
- **`reference_type` / `reference_id` stay the order.** The ledger's audit question is still *"what
  released order X's stock?"*, and `IDX_STOCK_MOVEMENT_REFERENCE` still answers it. Identity and
  reference are different jobs, and this is the first operation where they are different values.

### 3. A missing key is refused, not tolerated

`CancelAllocationUseCase` rejects a blank or absent key before any write. An unkeyed release
generates a NULL dedupe key and falls out of the UNIQUE silently — accepting it would mean accepting
a write with no guard at all, which is the state this ADR exists to end.

### 4. No probe

Commit Sale and Restock both `existsByReference` before writing, as a fast path. Cancel-Allocation
gets no equivalent, deliberately: the probe is an optimisation for a hot path, and this is not one
(a cancellation is rare and human-triggered). The duplicate-key catch alone is the guarantee, and
one mechanism that always holds is easier to reason about than two where only the second does.

## Alternatives Considered

- **Extend the UNIQUE to `type = 'release'` with the existing order reference.** Rejected — it is
  the trap this ADR is mostly about. Partial line cancellation makes a second legitimate release
  with identical key material, and the duplicate catch would silently swallow it.
- **An idempotency-key store in inventory** (the refund reserve-first shape,
  [ADR-036](036-idempotency-key-store-and-enforced-occ.md)). Rejected: ADR-036 chose one store,
  retail-owned, on the grounds that inventory writes have natural-key idempotency. This ADR narrows
  that claim rather than reversing it — cancel-allocation had no natural key, so one is supplied,
  and the *ledger* remains the dedupe substrate for every inventory write. A second table would be
  new machinery for one caller.
- **Track allocations per order** (an allocation row keyed by `(order, variant, location)`), making
  release idempotent by construction. The most correct answer and rejected on cost: it is a model
  change to the aggregate ADR-027 deliberately kept as running totals, and it would re-open the
  balance-authority question for one bug.
- **Leave it and document the risk.** Rejected. The risk was *already* documented — three comments
  said the operation was safe to retry, which is documentation pointing the wrong way. A fourth
  comment saying it is not would have left the same code with a better-informed reader.

## Consequences

### Positive

- All three post-commit cross-service calls are now idempotent against a **concurrent** redelivery,
  not just a sequential one, and by the same mechanism — a ledger UNIQUE over an operation identity.
- The four comments that asserted quantity-guarded safety are corrected to say what the guard does
  and does not do. That includes the shared helper, which can now state the per-operation table
  rather than one claim covering all three.
- `stock_movement` gains a column that says explicitly what produced a row, for the one operation
  where the reference could not.

### Negative

- `IAllocationCancelPayload` gains a **required** field, so every caller changes. Four did (two
  builders, two compensations). A fifth would fail to compile, which is the intended cost.
- One more nullable column on an append-only table, meaningful for one movement type out of six.
- The migration rebuilds a STORED generated column and its UNIQUE. No row is rewritten — every
  existing key recomputes to what it already was, since `operation_key` is NULL for all of them —
  but on a large table this is not a free ALTER. There is no production data (ADR-019), so the cost
  is theoretical here and named for whoever inherits it.

### Open

- **`ReleaseReservationUseCase` and the TTL sweeper are untouched and still unkeyed.** Neither is
  reached by the post-commit retry posture — the sweeper is a scheduled job over its own rows, and
  reservation release is driven by cart operations inside their own transaction — so neither has the
  redelivery-after-commit shape this ADR fixes. If either ever gains a cross-service caller, it
  needs the same treatment, and the `operation_key IS NOT NULL` arm is already the way in.

## References

- [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) §4 — Cancel-Allocation and
  the ledger this extends.
- [ADR-027](027-stocklevel-running-totals-and-stocklocation.md) — running totals are the balance
  authority and nothing reconciles them, which is why the corruption would have been silent.
- [ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) /
  [ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md) — the two siblings that had a
  natural key, and the post-commit ordering all three share.
- [ADR-040](040-persisted-cancelled-quantity-on-order-line.md) — persisted `cancelled_quantity`,
  which closed the request-level repeat and is the reason no derived key is unique.
- [ADR-026](026-price-append-only-ledger-and-tax-category.md) — the generated-column
  partial-unique-index emulation.
- [ADR-036](036-idempotency-key-store-and-enforced-occ.md) — the one idempotency store, and the
  claim about inventory's natural keys this narrows.
- [ADR-056](056-lifting-the-post-commit-retry-helper.md) — the lift whose one-file view of all three
  callers is what surfaced this.
