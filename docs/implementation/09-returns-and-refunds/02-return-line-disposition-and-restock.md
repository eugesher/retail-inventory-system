# Return-line disposition and restock — the inventory side

This document covers the **inventory side** of the returns flow: the
`inventory.stock.restock-from-return` RPC that puts a returned item's stock back on the
shelf. When a warehouse inspects received returns and dispositions a line as `restock`
(the goods are resellable), the returned units must re-enter sellable inventory — their
`quantity_on_hand` raised and an audit row written. This is the cross-service operation
that makes that happen.

The retail-side trigger — the warehouse **Inspect & Disposition** step that records each
line's condition/disposition and decides which lines to restock, then calls this RPC — is
documented in the disposition half of this flow (the retail companion section). This half
describes only the inventory operation it invokes.

It is reached **retail → inventory over RabbitMQ** (no gateway HTTP route — an operator
never calls restock directly; it is a consequence of an inspection). It honors
[ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md) (the returns
capability) and reuses the entire stock-movement machinery
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) put in
place — see also the sibling
[`03-stock-movement-typed-ledger.md`](../07-inventory-reservation-and-stock-movement/03-stock-movement-typed-ledger.md)
and [`08-receive-adjust-now-write-movements.md`](../07-inventory-reservation-and-stock-movement/08-receive-adjust-now-write-movements.md).

## 1. The `inventory.stock.restock-from-return` RPC

The contract lives in `libs/contracts/inventory/restock-from-return/` and is mirrored as
a routing key in `libs/messaging` (lock-step with `MicroserviceMessagePatternEnum`, the
ADR-008 wire agreement):

```ts
// inventory.stock.restock-from-return  (RPC, Retail → Inventory)
interface IRestockFromReturnPayload extends ICorrelationPayload {
  returnRequestId: number;
  lines: {
    returnLineId: number;     // the ReturnLine each restocked unit satisfies
    variantId: number;        // the catalog variant (opaque cross-service key)
    stockLocationId: string;  // the receiving location (resolved by the caller)
    quantity: number;         // strictly positive — units going back on-hand
  }[];
  actorId?: string | null;    // the warehouse staff who inspected; null = system
}

interface IRestockFromReturnResult {
  restocked: { returnLineId; variantId; stockLocationId; quantity }[];
}
```

**Why retail drives it from Inspect & Disposition.** Restock is not an inventory-initiated
event — inventory has no way to know a return was inspected, nor which lines came back
resellable. The decision is made warehouse-side during inspection: each `ReturnLine` gets
a `condition` (`new`/`damaged`/`used`) and a `disposition` (`restock`/`scrap`/`quarantine`).
Only `restock`-disposition lines re-enter sellable inventory; `scrap` and `quarantine`
write **no** stock movement (scrapped goods are destroyed, quarantined goods are held
aside). So the retail inspect step filters to the `restock` lines, resolves the receiving
location, and sends exactly those on this RPC — the inventory service never reads retail's
return tables.

**Why each line carries `returnLineId`.** Idempotency keys on `returnRequestId` (§3), so
the line-level id is not needed to dedupe. It rides the payload purely so the emitted
`inventory.stock.returned` event (§4) and the result can **name** which `ReturnLine` each
restocked unit satisfied — the retail caller correlates the restock back to the inspection
that triggered it. The same shape echoes back in `IRestockFromReturnResult`.

**Why the lines ride the payload.** Rather than have inventory read retail's
`return_request` / `return_line` tables, the caller sends the lines it wants restocked.
This keeps the operation a pure one-way command with no cross-service read — the same
"the request carries the lines" choice Allocate (ADR-030 §4) and Commit Sale (ADR-031)
made.

## 2. The `return` movement type — the first producer

Each restocked line increments `quantity_on_hand` by a positive `StockLevel.changeOnHand(+quantity)`
and appends **one** `StockMovement` of type `return`:

```
type: RETURN, quantity: +n,
referenceType: 'return-request', referenceId: String(returnRequestId)
```

`StockMovementTypeEnum.RETURN` has been part of the typed ledger vocabulary since ADR-030
§2 shipped the full six-type enum, but it had **no producer** until now — it sat dormant
exactly as `sale` did before Commit Sale (ADR-031) gave it one. Restock is its **first and
only producer**, and the `return` type's **fixed sign is positive**: the domain
`StockMovement` constructor places `RETURN` in its `POSITIVE_TYPES` set, so a `return`
movement with a non-positive quantity throws a plain `Error` at construction — the
sign-per-type invariant is enforced in the type system, not by the use case's discipline.
A restock can therefore only ever *raise* stock; an attempt to write a negative `return`
row is an internal bug caught immediately, never a client-visible 4xx.

`referenceType: 'return-request'` is the documented polymorphic reference value for
return-driven movements (ADR-030 §2). Paired with `referenceId = returnRequestId`, it
makes every restock traceable to the RMA that caused it in the audit ledger — and is the
exact `(reference_type, reference_id)` tuple the idempotency probe (§3) keys on.

**Running totals stay the balance authority.** Per ADR-027, the `StockLevel` running
counters (`quantityOnHand` / `quantityAllocated` / `quantityReserved`) are the source of
truth; the movement ledger is an **audit trail, not a balance**. The `return` row is
*recorded because* on-hand changed — it does not *cause* the balance and is never summed to
reconstruct it. Reserved/allocated are untouched, so a restock of `n` raises `available`
by exactly `n` (`available = onHand − allocated − reserved`).

## 3. Idempotency at the RPC layer — keyed on `returnRequestId`

Restock runs **retail → inventory over RMQ**, and the retail caller drives it **after** its
local inspection commits. A transient broker re-delivery could therefore deliver the same
restock twice — and a second increment would silently over-credit inventory. The defense
is the same one Commit Sale uses, keyed on the return instead of the fulfillment:

Before any write, the use case probes
`STOCK_MOVEMENT_REPOSITORY.existsByReference('return-request', String(returnRequestId))`.
If a `return` movement already references this return request, the restock already
happened — the use case **increments nothing, opens no transaction, invalidates no cache**,
and simply re-returns the request's lines mapped to result entries. This rides the existing
`IDX_STOCK_MOVEMENT_REFERENCE (reference_type, reference_id)` index — a `SELECT 1 … LIMIT 1`,
not a scan — and is a pure read, so the ledger's append-only invariant is untouched.

**Why per-request grain.** One Inspect → one restock RPC for the whole return. There is no
partial restock that would later need a *second* restock RPC for the same return, so the
right idempotency grain is the **return request**, not the line. (Contrast Commit Sale,
whose grain is the `fulfillmentId` because an order ships in multiple fulfillments.) The
line-level `returnLineId` is carried for naming (§1), not deduping.

This makes the cross-service retry safe: a redelivered restock is a no-op that re-returns
the same result, so the retail caller can retry on a timeout without fear of double-credit.

## 4. All-lines-atomic, the bounded write protocol, and no low-stock re-fire

Restock reuses the inventory module's shared write machinery rather than re-implementing it
— the `CommitSaleUseCase` template (idempotency-first, all-lines-atomic, load-once-per-level):

- The whole operation is wrapped in `stockCache.withInvalidation(work, resolveItems, …)`
  (ADR-023): the cache for each touched `(variantId, stockLocationId)` is invalidated
  **post-commit** so the next availability read reflects the restock. On a rejection,
  `work` never resolves and nothing is invalidated.
- Inside it, `runWithStockWriteRetry` opens a fresh transaction per attempt and retries a
  lost optimistic compare-and-swap up to the shared 5-attempt budget (ADR-030 §3) — exactly
  the no-oversell protocol Reserve/Allocate/Commit-Sale share, consuming the
  `stock_level.version` column ADR-027 shipped.
- Each attempt is **all-lines-atomic**: it loads each distinct level once (lazy-initializing
  a missing one — a returned variant may have no level yet at the receiving location, e.g. a
  fresh warehouse, the Receive precedent), applies every `changeOnHand` and builds every
  movement **in memory first**, then persists every level and appends every movement. A
  rejection on any line leaves nothing written; the ledger append runs *after* the
  version-checked persist, so a lost CAS leaves no orphan row and a retry appends exactly
  once.

**No low-stock re-fire.** Commit Sale, Adjust, and Transfer re-check the low-stock threshold
after they run because they *lower* on-hand and may cross it downward. Restock can only ever
*raise* on-hand, so it can never push a level at/below the threshold — the use case
deliberately **skips** `maybeEmitLowStock` entirely. This is why `restockOnce` does not even
track per-level totals (Commit Sale does, solely to feed the low-stock re-check).

**The `inventory.stock.returned` typed alias.** Post-commit, the use case emits two
best-effort events per line (ADR-020 — warn-and-swallow, never failing the committed write):
`inventory.stock.returned` (carrying `variantId`, `stockLocationId`, `quantity`,
`returnRequestId`, `returnLineId`) **and** the per-insert `inventory.stock-movement.recorded`
that every ledger append emits. Both land on `inventory_queue` as **reserved surfaces** (no
cross-service consumer bound yet; the intended consumer is a future event-store/audit
capability — the `inventory.stock.{allocated,committed}` precedent). The dedicated
`inventory.stock.returned` key is the **typed alias** for the positive `return` movement: it
lets a downstream consumer subscribe to returned-stock events specifically, without
filtering every high-volume `inventory.stock-movement.recorded`. It is the mirror of
`inventory.stock.committed` for the `sale` movement (ADR-031).

## 5. No new mutator, no cache version bump

Restock needs **no new `StockLevel` mutator** — a restock is a positive `changeOnHand`,
the same one Receive uses. (Contrast Commit Sale, which needed a dedicated `commitSale`
because it decrements *two* counters at once.)

There is likewise **no inventory cache key-version bump**. Restock changes the
`quantity_on_hand` *value*, not the cached `StockLevel` *shape* — the key stays at `v3`
(the version ADR-030 §7 bumped it to), and freshness is maintained by the ADR-023
post-commit `withInvalidation` fan-out, exactly as every other counter-changing operation
does.

## 6. Related documents

- [ADR-032 — Returns and refunds: the RMA lifecycle and restock](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)
  — the decision this work implements (restock as an inventory operation, the `return`
  movement as the `sale` mirror, idempotency on `returnRequestId`).
- [ADR-030 — Reservation TTL aggregate and the stock-movement ledger](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
  — the typed append-only ledger, the fixed-sign-per-type table, `existsByReference`, the
  bounded optimistic write protocol, and post-commit cache invalidation that restock reuses.
- [ADR-027 — `StockLevel` running totals](../../adr/027-stocklevel-running-totals-and-stocklocation.md)
  — why the running totals are the balance authority and the ledger is only an audit trail.
- The disposition half of this flow (the retail Inspect & Disposition companion) — how a
  warehouse inspection records each line's condition/disposition and decides which lines to
  send on this RPC.
- [`03-stock-movement-typed-ledger.md`](../07-inventory-reservation-and-stock-movement/03-stock-movement-typed-ledger.md)
  — the ledger that gained the `return` producer here.
