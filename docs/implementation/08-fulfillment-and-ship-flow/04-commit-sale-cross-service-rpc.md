# Commit Sale — the cross-service ship RPC

When an order's shipment physically leaves the warehouse, the units must stop
being merely *promised* and become *gone*: they leave `quantity_on_hand` (no
longer in stock) **and** clear from `quantity_allocated` (no longer reserved for
that order). The inventory side of that step is the **`inventory.stock.commit-sale`**
RPC, served by the inventory stock controller and driven by the retail ship flow.

This is the inventory ledger's long-awaited `sale`-movement producer: the
`StockMovementTypeEnum.SALE` value shipped with the typed ledger but had no writer
until now. The capability design is recorded in
[ADR-031](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md); the
counter/ledger mechanics it reuses are
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)'s.

The use case lives at
`apps/inventory-microservice/src/modules/stock/application/use-cases/commit-sale.use-case.ts`;
the `StockLevel.commitSale` mutator it drives is in
`apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts`.

## 1. The RPC contract, and why retail drives it after its local commit

`inventory.stock.commit-sale` carries an `ICommitSalePayload`
(`libs/contracts/inventory/commit-sale/commit-sale.payload.ts`):

```ts
interface ICommitSalePayload extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: string;
  lines: { variantId: number; stockLocationId?: string; quantity: number }[];
  actorId?: string | null;
}
```

and resolves an `ICommitSaleResult` — `{ committed: { variantId; stockLocationId;
quantity }[] }`, the lines that were shipped, in request order.

Two shape decisions echo the allocate RPC ([ADR-030 §4](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)):

- **The lines ride the payload.** The inventory service never reads retail's
  `fulfillment` tables — the shipment's lines travel on the request, so the commit
  needs no cross-service read (the same reason allocate carries its lines).
- **`stockLocationId` is optional per line**, defaulting to
  `INVENTORY_DEFAULT_STOCK_LOCATION` at the edge — a shipment from the default
  warehouse omits it.

**Retail drives this RPC *after* its local ship commit, not inside it.** The ship
operation (the retail side, see
[03 — Ship-triggered capture](03-ship-triggered-capture-q5.md)) commits its own
transaction first — the `Fulfillment` flips to `shipped`, the payment captures —
and *then* fires commit-sale over RMQ. This is the deliberate inverse of
**allocate**, which runs *inside* the retail place transaction (a rejection there
must roll the place back). Why the difference?

- At **place** time, an out-of-stock allocate must *prevent* the order — so it
  runs pre-commit and a rejection aborts the place.
- At **ship** time, the stock has already been physically picked and the carrier
  has it; an inventory hiccup must **not** un-ship a parcel that is on a truck. So
  the local ship commits first and the counter sync is an eventual-consistency
  follow-up. The local ship is **not** rolled back if commit-sale fails — instead,
  the operation is safe to **retry** (next section).

## 2. Idempotency at the RPC layer — keyed on `fulfillmentId`

Because commit-sale runs after the local commit and over an at-least-once broker
([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)), a transient failure
can **re-deliver** the same commit. Decrementing the counters twice would corrupt
the running totals. The guard is idempotency keyed on **`fulfillmentId`**, and it
reuses a structure the use case already writes — the audit ledger's reference
columns:

```
existsByReference('fulfillment', fulfillmentId)
  → SELECT 1 FROM stock_movement
    WHERE reference_type = 'fulfillment' AND reference_id = ?  LIMIT 1
```

served by the existing `IDX_STOCK_MOVEMENT_REFERENCE (reference_type,
reference_id)` index. The use case runs this probe **before any write**:

- If a `sale` movement already references this fulfillment, the commit already
  happened. The use case re-derives the result from the request's lines and
  returns it **without decrementing again** — and without even opening a
  transaction or invalidating the cache (nothing changed, so there is nothing to
  invalidate).
- Otherwise it proceeds to the decrement.

This is what makes the cross-service retry safe: the *first* delivery writes the
`sale` rows; every *re-delivery* sees them and short-circuits. `existsByReference`
is a **read** — it is added to `IStockMovementRepositoryPort` alongside `append` /
`listByVariant` without breaking the append-only invariant (no `save` / `update` /
`delete` is expressible against the port; see
[06 — the `sale` movement type](06-stockmovement-sale-type.md)).

No separate idempotency-key store is needed: the ledger we write anyway *is* the
dedup record. The realistic replay is a sequential re-delivery (after a broker
timeout), not concurrent traffic — retail's ship is one sequential operation — so
a cheap pre-transaction read suffices.

## 3. All-lines-atomic, on the shared optimistic write protocol

A shipment may span several order lines (several variants, or one variant across
locations). Commit Sale is **all-lines-atomic**: it computes every line in memory
first, then writes — exactly the contract Allocate and Cancel-Allocation already
use ([06 — Allocate on place](../07-inventory-reservation-and-stock-movement/06-allocate-on-place.md)).

The transaction body (`commitOnce`) runs in three phases:

1. **Load** each distinct `(variantId, stockLocationId)` `StockLevel` exactly once,
   capturing its optimistic-lock `version` before any mutation (`loadDistinctLevels`,
   shared with Allocate/Cancel).
2. **Compute** per line: `level.commitSale(quantity)` mutates the in-memory level
   (decrementing on-hand **and** allocated), and a `sale` `StockMovement` is built.
   Any rejection — an over-allocated drift (a plain `Error`/500) or an on-hand
   shortfall (`STOCK_RESULT_NEGATIVE`/409) — throws **here**, before a single write.
3. **Write**: persist each distinct level once with its captured `version`, then
   append the `sale` movements.

The whole thing is wrapped in
`stockCache.withInvalidation(runWithStockWriteRetry(...))`
([ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) /
[ADR-030 §3](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)):

- `runWithStockWriteRetry` opens a fresh transaction per attempt and retries up to
  5 times on a lost optimistic compare-and-swap (`StockWriteConflictError`) — a
  domain rejection (the shortfall above) propagates immediately and is never
  retried.
- `withInvalidation` awaits the committed transaction, then fans the cache
  invalidation out per `(variantId, stockLocationId)` — strictly **post-commit**.
- A rejection on any line rolls the whole transaction back: a partial ship never
  commits, and because the ledger append runs *after* the version-checked persist,
  a burned retry attempt never leaves an orphan `sale` row.

After commit, the use case emits — best-effort, warn-and-swallow
([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)) — one
`inventory.stock.committed` event and one `inventory.stock-movement.recorded`
event per line, and re-checks low-stock once per distinct level (on-hand fell, so
a depletion at/below the threshold re-fires `inventory.stock.low`, reusing the
shared `maybeEmitLowStock` helper that Adjust and Transfer use).

## 4. Reachability today

The RPC is reachable **only over RMQ** — there is no gateway HTTP route. Its sole
caller is the retail ship flow
([03 — Ship-triggered capture](03-ship-triggered-capture-q5.md)), which invokes it
through a module-prefixed gateway port from inside the retail microservice. An
operator never calls commit-sale directly; it is a consequence of shipping a
fulfillment.

## See also

- [ADR-031 — Fulfillment aggregate and ship-triggered capture](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)
- [ADR-030 — Reservation TTL aggregate and the stock-movement ledger](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
  (the counter mutators, the optimistic write protocol, the ledger)
- [ADR-027 — `StockLevel` running totals and `StockLocation`](../../adr/027-stocklevel-running-totals-and-stocklocation.md)
  (the running totals that stay the balance authority)
- [06 — The `sale` movement type and the two-counter decrement](06-stockmovement-sale-type.md)
- [03 — Ship-triggered capture](03-ship-triggered-capture-q5.md) (the retail caller)
- [Allocate on place](../07-inventory-reservation-and-stock-movement/06-allocate-on-place.md)
  (the all-lines-atomic, lines-on-the-payload precedent)
