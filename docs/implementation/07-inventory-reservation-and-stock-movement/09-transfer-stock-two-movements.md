# Transfer Stock — one variant, two locations, two paired movements

**Transfer Stock** moves on-hand for one variant from one stock location to
another. It is a staff operation fronted by
`POST /api/inventory/variants/:variantId/stock/transfer` (permission
`inventory:transfer`) and served by the inventory RPC
`inventory.stock-level.transfer` → `TransferStockUseCase`. A transfer debits the
source by `quantity`, credits the destination by the same `quantity`, and records
the move as a **pair of `adjustment` ledger rows** — all in **one transaction**.

It is the inventory ledger's last writer: with Transfer wired, **every
counter-changing inventory operation leaves a `stock_movement` row** (Receive a
`receipt`, Adjust a signed `adjustment`, Reserve/Release/Cancel a `release`,
Allocate an `allocation`, and now Transfer a paired `adjustment` per leg).

Related decisions:
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
(a transfer is two `adjustment` movements paired by a shared `transfer` reference,
not a seventh movement type; in-transit modelling is out of scope),
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) (the
`inventory:transfer` permission gate),
[ADR-009](../../adr/009-port-adapter-at-the-gateway.md) (the gateway
port/adapter split — `ClientProxy` only in the adapter),
[ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) (post-commit
cache invalidation — here for **both** locations),
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md) (the
running totals stay the balance authority — the ledger is audit only). The shared
optimistic write protocol Transfer runs inside is documented in
[04-no-oversell-invariant-and-occ.md](04-no-oversell-invariant-and-occ.md); the
ledger record itself in
[03-stock-movement-typed-ledger.md](03-stock-movement-typed-ledger.md); the other
two on-hand writers in
[08-receive-adjust-now-write-movements.md](08-receive-adjust-now-write-movements.md).

## Two `adjustment` movements, not a `transfer` type

The `stock_movement` ledger fixes a **sign per type**: `receipt` / `return` are
positive, `sale` / `allocation` / `release` are negative, and `adjustment` is the
one type that accepts either sign (as long as it is non-zero). A transfer is
intrinsically two-directional — it removes units at the source and adds them at
the destination — so a single "transfer" row would need a sign that means two
things at once, breaking that invariant.

So a transfer is modelled as a **pair** of `adjustment` rows:

| Leg         | Location          | `quantity` | `reasonCode`   |
| ----------- | ----------------- | ---------- | -------------- |
| source      | `fromLocationId`  | `−quantity`| `transfer-out` |
| destination | `toLocationId`    | `+quantity`| `transfer-in`  |

Both rows carry the **same** `referenceType = 'transfer'` and the **same**
`referenceId` — a single `crypto.randomUUID()` generated per transfer. That shared
id is the pairing key: a query for `(reference_type = 'transfer', reference_id =
<id>)` returns exactly the two legs of one transfer, so the operation is fully
reconstructable from the ledger even though no row's `type` says "transfer". The
ledger's `IDX_STOCK_MOVEMENT_REFERENCE (reference_type, reference_id)` index backs
that lookup. Both rows are attributed to the acting staff user (`actorId`, folded
in from `@CurrentUser().id` at the HTTP edge; **null = system**).

Choosing two `adjustment`s over a new `transfer` movement type keeps the type set
small and the sign rule airtight — a reader of the ledger never has to special-case
a type whose sign is ambiguous. `referenceType` / `referenceId` already exist to
carry exactly this kind of cross-row correlation (the `cart` / `order` references
the reservation and allocation legs use), so the pairing needs no schema change.

## One transaction for both legs

A transfer touches two `stock_level` rows; both must move or neither may. The use
case composes the same building blocks the other on-hand writers use:

```
withInvalidation(                              // ADR-023: invalidate AFTER commit
  runWithStockWriteRetry(                       // bounded optimistic retry (5 attempts)
    transaction(                                // one fresh tx per attempt
      read source level   (capture version)     // lazy-init a missing row to zero
        → source.changeOnHand(−quantity)        // may reject: STOCK_RESULT_NEGATIVE
      read dest level     (capture version)     // lazy-init a missing row to zero
        → dest.changeOnHand(+quantity)          // never rejects (adding stays ≥ 0)
        → persistStockLevelChange(source, srcVersion)   // CAS UPDATE
        → persistStockLevelChange(dest,  dstVersion)    // CAS UPDATE
        → append source `adjustment` (transfer-out)     // ledger, SAME scope
        → append dest   `adjustment` (transfer-in)      // ledger, SAME scope
    )
  ),
  resolveItems → BOTH (variantId, location) pairs,        // ADR-023 invalidate set
)
```

Both `StockLevel` persists and both ledger appends join the **same**
`ITransactionScope`, so a lost compare-and-swap on **either** row throws
`StockWriteConflictError`, rolls the whole attempt back, and `runWithStockWriteRetry`
re-reads both rows fresh and retries (up to five attempts, then a `409
STOCK_WRITE_CONFLICT`). Because the two `changeOnHand` mutations happen **before**
any persist, a domain rejection — the source debit driving on-hand below zero —
throws before a single write, so nothing is half-applied. The unit specs prove
both: a conflict-then-succeed run appends **exactly two** rows (not two per
attempt), and an exhausted-budget run leaves the source counter untouched with
zero ledger rows.

After the commit, the cached availability is invalidated for **both** locations
(ADR-023): `resolveItems` returns both `(variantId, stockLocationId)` pairs.
A per-`variantId` prefix wipe would already cover both facets, but passing both
items keeps the intent explicit.

### The over-transfer rejection reuses the below-zero guard

Transferring more than the source holds needs **no new error code**: the source
`changeOnHand(−quantity)` already throws `STOCK_RESULT_NEGATIVE` (a `409`) the
moment the move would drive on-hand below zero — the same invariant a too-large
negative Adjust hits. An empty source is the same path: a missing source level is
lazy-initialised to zero, and `changeOnHand(−quantity)` on zero rejects
immediately. Two genuinely new `400` codes cover the inputs unique to transfer:
`INVENTORY_TRANSFER_QUANTITY_INVALID` (a non-positive / non-integer quantity) and
`INVENTORY_TRANSFER_SAME_LOCATION` (source equals destination — a no-op that would
debit then credit the same row). Unknown or inactive locations reuse the existing
`STOCK_LOCATION_NOT_FOUND` / `STOCK_LOCATION_INACTIVE` codes via the shared
`requireActiveLocation` guard, run for **both** ends.

## A transfer moves on-hand only — reserved and allocated stay put

`StockLevel` keeps three counters: `quantityOnHand`, `quantityReserved` (held
against carts), and `quantityAllocated` (committed to orders), with `available =
onHand − reserved − allocated`. A transfer moves **on-hand only** — it never
touches the source's `quantityReserved` or `quantityAllocated`. Those holds belong
to carts and orders that expect to be fulfilled *from that location*; silently
relocating them would break that expectation.

This is safe — and self-enforcing — precisely because of the below-zero guard.
`changeOnHand(−quantity)` rejects when `onHand − quantity < 0`, i.e. it lets a
transfer take **at most the full on-hand**. If holds are stranded below available
(say 10 on hand, 8 reserved → 2 available, and a transfer of 5), the transfer is
*not* blocked by the holds — it is allowed to take up to all 10 on hand, leaving 5
on hand and 8 reserved, i.e. `available = −3`. That is the deliberate model: a
transfer is a physical stock movement authorised by warehouse staff, and on-hand
is what is physically present to move; the reservation/allocation accounting is
reconciled separately, not by blocking the physical move. The guard only stops a
transfer from moving units that **do not physically exist** (more than on-hand) —
never units that exist but happen to be spoken for. Modelling "don't strand holds"
as a transfer-time rejection would couple a physical move to logical accounting in
a way ADR-030 explicitly keeps separate.

## Low-stock parity with Adjust

A transfer that empties a warehouse should raise a reorder alert exactly like a
negative adjustment does. The post-commit low-stock check is the **same policy**,
extracted into a shared `maybeEmitLowStock` helper that both Adjust and Transfer
call: when a **decrease** drives the post-commit on-hand to at/below
`INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`, it emits `inventory.stock.low` (consumed
by the notification service). Transfer runs that check on the **source** leg only
(the source debit is always a decrease); the destination only gains units, so it
is never a depletion event. Like every post-commit emit it is best-effort — a
broker hiccup is warn-logged, never raised, because the transfer already committed.

Extracting the helper rather than copying it keeps the depletion-signal policy in
one place: a future change to the threshold semantics is made once and both
operations inherit it.

## In-transit modelling is deferred

This capability records a transfer as an **instantaneous** move: the units leave
the source and arrive at the destination in the same transaction, with nothing in
between. Real warehouses often model goods *in transit* — a transfer order, a
shipment, a receiving step at the far end — so that stock is neither fully at the
source nor fully at the destination for a while. That is deliberately **out of
scope**: a transfer here writes no in-transit document and no intermediate state.
If in-transit tracking is added later, it layers on top — a transfer-order
aggregate with its own lifecycle, whose ship and receive steps each move on-hand
and append their own ledger rows — without changing the instantaneous transfer
this note describes, which remains the right model for adjustments between two
locations a single operator controls.

## Seed data

The migration provisions only `default-warehouse`, so a transfer had no
destination on a freshly seeded database. The seed now adds a second active
location, `backup-store` (a `store`-type location), via an idempotent
`INSERT IGNORE` in `scripts/seeds/stock-location.sql`, registered before
`stock-level.sql`. The seeded `warehouse@example.com` staff user (role
`warehouse-staff`) already carries `inventory:transfer`, so the
[`http/inventory.http`](../../../http/inventory.http) `transferStock` request runs
end-to-end against the seeded database: it debits 5 from `default-warehouse` and
credits 5 to `backup-store`, and the companion `transferStockOverSource` request
demonstrates the `409` over-transfer rejection.
