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

Two shape decisions echo the allocate
RPC ([ADR-030 §4](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)):

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

This is what makes a *sequential* cross-service retry safe: the first delivery writes
the `sale` rows; a re-delivery that arrives after it finished sees them and
short-circuits. `existsByReference` is a **read** — it is added to
`IStockMovementRepositoryPort` alongside `append` / `listByVariant` without breaking
the append-only invariant (no `save` / `update` / `delete` is expressible against the
port; see [06 — the `sale` movement type](06-stockmovement-sale-type.md)).

No separate idempotency-key store is needed: the ledger we write anyway *is* the
dedup record.

> **But the probe alone was never the guarantee, and the premise it rested on was wrong.**
> This section originally reasoned that "the realistic replay is a sequential re-delivery,
> not concurrent traffic — retail's ship is one sequential operation — so a cheap
> pre-transaction read suffices." A **timeout does not cancel the RPC**: a retry fired after
> one travels alongside the original, and RabbitMQ never promises a redelivery waits for the
> first to finish. Two deliveries in flight at once both read "absent" and both decremented,
> permanently and silently — `stock_level`'s running totals *are* the balance authority and
> the ledger is explicitly not expected to reconstruct them (ADR-030 §2).
>
> Migration `1783872387242` closed it with **`UC_STOCK_MOVEMENT_DEDUPE`** — a UNIQUE over a
> STORED generated column `movement_dedupe_key`, non-`NULL` only for `sale` and `return`
> rows, emulating the partial unique index MySQL does not have (the `price.open_scope_key`
> technique, ADR-026, on its third application). The key is
> `(type, reference_type, reference_id, variant_id, stock_location_id)` — **the level, not
> just the request** — because one commit-sale writes one `sale` row *per line* under a
> single `fulfillmentId`, so a narrower key would reject the second line of every ordinary
> multi-item shipment. The `type IN ('sale','return')` scope is load-bearing in the other
> direction: a transfer writes **two** `adjustment` rows under one `transfer` reference.
>
> So the shape today is: **the probe is an optimisation; the constraint is the guarantee.**
> The use case keeps the probe (a redelivery arriving after the first call finished is the
> overwhelmingly common case, and short-circuiting it costs one indexed `SELECT` instead of
> a whole transaction that would only roll back), re-probes *under the transaction scope*,
> and catches the losing INSERT's duplicate-key error. All three paths return the same
> no-op result and **none of them rethrows** — the handler is an `@MessagePattern`, and an
> exception out of one is blind-redelivered by the broker in a hot loop.
> `test/concurrent-commit-sale.e2e-spec.ts` pins both halves: the race *and* the multi-line
> shipment that must keep working.

## 3. All-lines-atomic, on the shared optimistic write protocol

A shipment may span several order lines (several variants, or one variant across
locations). Commit Sale is **all-lines-atomic**: it computes every line in memory
first, then writes — exactly the contract Allocate and Cancel-Allocation already
use ([06 — Allocate on place](../07-inventory-reservation-and-stock-movement/06-allocate-on-place.md)).

The transaction body (`commitOnce`) runs in four phases (the first was added with the
dedupe constraint above):

0. **Re-probe under the scope.** `existsByReference(..., scope)` asks the very snapshot
   this attempt will write in whether a concurrent delivery already committed. If so it
   throws `LedgerReplayError` and unwinds **now** — phase 2 would otherwise re-read a level
   whose `quantity_allocated` the winner already consumed and raise `commitSale`'s drift
   `Error`, a 500 out of a `@MessagePattern`. `LedgerReplayError` and
   `UC_STOCK_MOVEMENT_DEDUPE` cover disjoint windows, which is why both exist.
1. **Load** each distinct `(variantId, stockLocationId)` `StockLevel` exactly once,
   capturing its optimistic-lock `version` before any mutation (`loadDistinctLevels`,
   shared with Allocate/Cancel). A request naming the **same** level twice is rejected up
   front by `requireDistinctLevels` — two such lines would collide on
   `UC_STOCK_MOVEMENT_DEDUPE` and the duplicate-key catch would misread the collision as a
   replay.
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

- `runWithStockWriteRetry` opens a fresh transaction per attempt and retries on a lost
  optimistic compare-and-swap (`StockWriteConflictError`) — a domain rejection (the
  shortfall above) propagates immediately and is never retried. The budget was a
  hardcoded `MAX_WRITE_ATTEMPTS = 5` when this shipped; it is now the injected
  `OCC_RETRY_ATTEMPTS` token (default `5`,
  [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md)), and the loop
  itself moved into the one shared `runWithOccRetry`
  ([ADR-045](../../adr/045-one-occ-retry-protocol.md)) — `runWithStockWriteRetry` kept
  its name and its file and now only binds to it.
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
- [ADR-027 — `StockLevel` running totals and
  `StockLocation`](../../adr/027-stocklevel-running-totals-and-stocklocation.md)
  (the running totals that stay the balance authority)
- [06 — The `sale` movement type and the two-counter decrement](06-stockmovement-sale-type.md)
- [03 — Ship-triggered capture](03-ship-triggered-capture-q5.md) (the retail caller)
- [Allocate on place](../07-inventory-reservation-and-stock-movement/06-allocate-on-place.md)
  (the all-lines-atomic, lines-on-the-payload precedent)
