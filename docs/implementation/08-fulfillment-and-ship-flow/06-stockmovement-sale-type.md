# The `sale` movement type and the two-counter decrement

The inventory audit ledger has shipped six movement types since the typed-ledger
foundation, but one of them — **`sale`** — had no producer. Commit Sale
([04 — the cross-service ship RPC](04-commit-sale-cross-service-rpc.md)) is its
first writer. This note explains the `sale` row it appends and the counter change
it records.

## 1. `sale` closes the last unwritten ledger type

`StockMovementTypeEnum` (`libs/contracts/inventory/enums/stock-movement-type.enum.ts`)
fixed the complete six-type vocabulary up front, so a new kind of stock movement
never needs a schema change. Each type has a **fixed sign**; `sale` is one of the
strictly-negative ones:

| Type         | Sign           | Reading                                       | First producer                |
|--------------|----------------|-----------------------------------------------|-------------------------------|
| `receipt`    | strictly **+** | a goods-in raised on-hand                     | Receive Stock                 |
| `return`     | strictly **+** | a customer return re-entered on-hand          | Restock From Return (ADR-032) |
| `sale`       | strictly **−** | stock physically shipped on a fulfilled order | **Commit Sale (this change)** |
| `allocation` | strictly **−** | stock committed firm to a placed order        | Allocate                      |
| `release`    | strictly **−** | a hold / allocation torn down                 | Release, Cancel-Allocation    |
| `adjustment` | either, non-0  | an operator's signed correction               | Adjust, Transfer (paired)     |

A `sale` movement is always **strictly negative** — the constructor enforces it,
and re-asserts it on the load path, so a corrupted stored sign is rejected on read
(the same defensive posture every type takes). Commit Sale builds each row as:

```ts
StockMovement.record({
    variantId, stockLocationId,
    type: StockMovementTypeEnum.SALE,
    quantity: -line.quantity,          // strictly negative
    reasonCode: null,
    referenceType: 'fulfillment',      // the polymorphic reference …
    referenceId: fulfillmentId,        // … back to the shipment that caused it
    actorId,                           // the staff who shipped, or null = system
});
```

`referenceType: 'fulfillment'` / `referenceId: fulfillmentId` is what makes the
movement both **traceable** ("which shipment shipped these units?") and the
**idempotency anchor** for the RPC — the `(reference_type, reference_id)` index
backs the `existsByReference('fulfillment', fulfillmentId)` replay guard
([04 §2](04-commit-sale-cross-service-rpc.md)). One `sale` row is appended per
shipped line, in the same transaction as the counter change it records.

> Those two columns have since acquired a second, enforcing role. Migration
> `1783872387242` added the STORED generated column `movement_dedupe_key` —
> `CONCAT(type, reference_type, reference_id, variant_id, stock_location_id)`, non-`NULL`
> **only** for `sale` and `return` rows — under the UNIQUE `UC_STOCK_MOVEMENT_DEDUPE`. It
> turns the reference pair from a hint the probe reads into a constraint the database
> refuses to break, which is what makes the RPC idempotent against *concurrent*
> redeliveries and not merely sequential ones. Note the key reaches down to
> `(variant_id, stock_location_id)`: a `sale` row is written **per line**, all sharing one
> `fulfillmentId`, so a key stopping at the reference would reject the second line of
> every ordinary multi-item shipment.

## 2. Why a commit decrements **both** on-hand **and** allocated

The single new `StockLevel` mutator, `commitSale(quantity)`, decrements **two**
counters in **one** mutation (a single `version` bump):

```
quantityOnHand     -= quantity
quantityAllocated  -= quantity
```

This follows directly from the availability identity
([ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)):

```
available = quantityOnHand − quantityAllocated − quantityReserved
```

Trace what each counter means at ship time. Before the ship, the units were
*allocated* — physically present (`onHand`) but already promised to this order
(`allocated`), so they did **not** count toward `available`. Shipping them removes
them from the warehouse (`onHand` falls) and they are no longer promised
(`allocated` falls). Because **both** decremented counters subtract from
`available`, the two changes cancel:

```
Δavailable = −Δquantity − (−Δquantity) = 0
```

That is exactly right: **shipping promised stock neither frees nor consumes
sellable inventory.** The units were never available to sell, and after they ship
they are simply gone. `quantityReserved` is untouched.

**Decrementing only `quantityOnHand` was rejected.** It would leave
`quantityAllocated` permanently inflated by every shipped unit — the allocated
pool would never clear — so `available = onHand − allocated − reserved` would
drift *downward* forever, permanently understating what is sellable. The allocated
counter is a *live* promise; once the promise is fulfilled by a physical ship, it
must be released, not stranded.

Two guards protect the mutator, and the **error type encodes who can cause the
condition**:

- `quantity ≤ quantityAllocated` — over-committing more than is allocated is a
  *counter drift*. The shipment's lines were built from the order's own allocation,
  so this can only happen on an internal bug, never user input → a plain `Error`
  (surfaces as a 500), the `allocateFromReserved` drift precedent.
- `quantity ≤ quantityOnHand` — if physical on-hand fell below the allocated
  amount (a prior negative Adjust), shipping would drive on-hand negative. An
  operator *can* reach this, so it is the typed
  `STOCK_RESULT_NEGATIVE` (409) the presentation filter maps — never a 500.

## 3. Audit trail, not balance authority

The `sale` rows are an **audit log; they are not the balance.** The running totals
on `StockLevel` remain the single source of truth (ADR-027) — exactly the decision
that retired the old summed-ledger model. The ledger answers *"what happened, and
why?"*: a `sale` row records that a specific quantity shipped against a specific
fulfillment, attributed to a specific actor, at a specific instant. The counters,
never a sum of rows, say how much stock exists. (Consistent with the per-type sign
rule, an `allocation` and the `sale` that fulfils it are **both** negative, so the
rows deliberately do **not** net against the original receipt.)

## 4. Reserved downstream surfaces

Each committed line emits two events onto the inventory service's own
`inventory_queue`, both **reserved surfaces** with no *business* consumer — the
`inventory.stock.{reserved,allocated,released}` precedent:

- **`inventory.stock.committed`** (`IInventoryStockCommittedEvent`) — the
  past-tense ship notification: `{ variantId, stockLocationId, quantity, orderId,
  fulfillmentId, eventVersion: 'v1', occurredAt, correlationId }`.
- **`inventory.stock-movement.recorded`** — the high-volume per-ledger-insert
  event every counter-changing operation emits, carrying the `sale` row's fields.

Both are best-effort, post-commit (warn-and-swallow on a broker hiccup): the
counter and ledger row already committed inside the transaction, so failing the
RPC over a publish glitch would mislead the caller into thinking the ship did not
record.

> **The "future audit / event-store capability" named here has since arrived.**
> [ADR-034](../../adr/034-isolated-eventstore-database.md) /
> [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) built the event-store
> microservice on its own `ris_eventstore` database, and every producer — including
> `StockRabbitmqPublisher` — now **dual-publishes** each event onto the `ris.events` topic
> exchange through the shared `RisEventsMirrorPublisher`, after the primary `emit` and
> best-effort. So both events above are ingested by the firehose into `domain_event` and
> are queryable over `audit.event.query`. "Reserved surface" now means precisely *no
> business consumer reacts to it* — not *nothing observes it*.

## See also

- [04 — Commit Sale, the cross-service ship RPC](04-commit-sale-cross-service-rpc.md)
  (the use case that writes these rows)
- [ADR-031 — Fulfillment aggregate and ship-triggered capture](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)
- [ADR-030 — Reservation TTL aggregate and the stock-movement ledger](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
  (the six-type ledger and its sign rule)
- [ADR-027 — `StockLevel` running totals and
  `StockLocation`](../../adr/027-stocklevel-running-totals-and-stocklocation.md)
  (running totals are the balance authority)
- [The
  `StockMovement` append-only typed ledger](../07-inventory-reservation-and-stock-movement/03-stock-movement-typed-ledger.md)
  (the type set, sign invariant, and append-only enforcement)
