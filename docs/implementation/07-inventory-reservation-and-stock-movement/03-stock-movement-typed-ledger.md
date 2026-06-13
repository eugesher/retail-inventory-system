# The `StockMovement` append-only typed ledger

This is the inventory **audit trail**: an immutable record of *why* a stock
counter changed. It ships the `StockMovement` domain model, the `stock_movement`
table, the `STOCK_MOVEMENT_REPOSITORY` port, and the wire contracts
(`StockMovementTypeEnum` + `StockMovementView`). It is a foundation: **no producer
writes movements yet** — the writers (Release, Allocate, Cancel-Allocation,
Receive, Adjust, Transfer) and the audit read RPC arrive with later inventory
work. The whole capability design is recorded in
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md).

The model lives at
`apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts`;
the table is created by
`migrations/1781338464522-CreateStockMovementTable.ts`.

## 1. The six types and their signs

A movement's `type` is one of six values, and the **sign of `quantity` is fixed by
the type**. The reading is physical: positive rows record stock *entering*
on-hand, negative rows record stock *leaving* or a *hold being torn down*, and
`adjustment` carries the operator's own signed delta.

| Type         | Sign            | Reading                                                     |
| ------------ | --------------- | ---------------------------------------------------------- |
| `receipt`    | strictly **+**  | stock physically arrived (a goods-in)                      |
| `return`     | strictly **+**  | a customer return re-entered on-hand                       |
| `sale`       | strictly **−**  | stock left on a fulfilled sale                             |
| `allocation` | strictly **−**  | stock committed (held firm) to a placed order              |
| `release`    | strictly **−**  | a hold/allocation was torn down (recorded as it unwinds)   |
| `adjustment` | either, non-0   | the operator's signed correction (cycle count, breakage…)  |

The invariant is enforced in the `StockMovement` constructor and re-asserted on
the load path (`reconstitute`), so a corrupted stored sign is rejected on read.
Because movements are constructed by use cases from already-validated counter
changes — never from raw user input — an illegal sign is an **internal bug**, so
it throws a plain `Error`, deliberately **not** a typed `InventoryDomainException`
that the presentation filter would surface as a client-facing 4xx. This mirrors
`StockLevel.requireNonNegativeInt` and the `OrderLine` money checks.

`quantity` must always be a **non-zero integer**: a zero-delta movement records
nothing, so it is rejected for every type.

The enum carries all six values now even though `sale` and `return` gain producers
only with the later fulfilment/returns capabilities. `StockMovementTypeEnum` is
the complete vocabulary ADR-030 pins, so a movement row never needs a schema change
to record a kind that was always foreseen.

## 2. Audit trail, not balance authority

The ledger is an **audit log; it is not the source of truth for the balance.**
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)'s
`StockLevel` running totals (`quantityOnHand` / `quantityAllocated` /
`quantityReserved`) remain authoritative — the same decision that retired the old
`product_stock` ledger, whose read cost grew with history.

Critically, **the sum of movement rows is not expected to reconstruct on-hand.**
The per-type sign rule makes this explicit: an `allocation` and the `release` that
cancels it are **both negative**, so they do **not** net to zero. The ledger
answers "what happened, and why?" — it is read for an audit timeline, an
operator's reason trail, or a reference back to the business document — but the
counters, not a row sum, say how much stock exists. Deriving balances by summing
the ledger was considered and rejected (ADR-030, Alternatives §4) for exactly the
read-cost reason ADR-027 already settled.

## 3. Polymorphic reference

`referenceType` / `referenceId` pair a movement with the business document that
caused it — an `allocation` references the `order`, a cart-driven `release`
references the `cart`, a stock move references a `transfer`, a return references a
`return-request`:

- `referenceType` is a **plain string, not an enum**. The reference vocabulary
  grows with later capabilities (transfers, returns, …), and pinning it to an enum
  now would force a contract change every time a new document kind learns to move
  stock. The documented values are `cart` / `order` / `transfer` /
  `return-request`.
- The pair carries **no foreign key**. An FK cannot target four different tables,
  so — exactly like the polymorphic `media_asset.owner_id`
  ([ADR-029](../../adr/029-category-materialized-path-and-polymorphic-media.md))
  and the retail `address` owner — the reference columns are FK-less. The
  compensation is twofold: the `IDX_STOCK_MOVEMENT_REFERENCE
  (reference_type, reference_id)` index makes "what did this document cause?"
  cheap, and the writing use case (a later capability) is responsible for
  supplying a valid pair.

`actorId` records who triggered the movement (a staff or customer id); **null
means a system action** — an auto-init, a sweeper, an event-driven unwind.

## 4. Append-only enforcement, layer by layer

"Append-only" is not a convention here — it is made **unexpressible** at every
layer, so there is no API through which a movement could be mutated or removed:

1. **Domain — frozen instances.** Every `StockMovement` field is `public
   readonly`, and the constructor ends with `Object.freeze(this)` (the `OrderLine`
   precedent). The class exposes **no instance methods at all** — no mutators, no
   getters — so its prototype carries only the constructor. A constructed movement
   cannot change at runtime; a strict-mode write throws.
2. **Port — only `append` + `listByVariant`.** `IStockMovementRepositoryPort` has
   no `save`, `update`, or `delete`. An UPDATE/DELETE is not even *typeable*
   against the seam the use cases inject. `append` is scope-aware so a movement is
   written in the **same transaction** as the `StockLevel` counter change that
   caused it — a rolled-back counter change leaves no orphan movement row.
3. **Repository — INSERT only.** `StockMovementTypeormRepository` implements the
   port **directly**, deliberately *not* extending `BaseTypeormRepository` (whose
   public `save` / `softDelete` would reintroduce mutation). Its one write verb,
   `append`, uses TypeORM's `insert` (never `save`-with-id), then re-reads by the
   DB-assigned BIGINT so the returned record carries the concrete `id` and stored
   `occurred_at`.
4. **Schema — inert `updated_at` / `deleted_at`.** The table inherits the
   `BaseEntity` audit columns, but the ledger never updates or soft-deletes a row,
   so `updated_at` and `deleted_at` are **inert by construction** (stated in the
   migration). The `occurred_at` column — the business instant the movement
   happened — is the only time field that matters, and it backs the newest-first
   audit scan via the descending `IDX_STOCK_MOVEMENT_VARIANT_OCCURRED (variant_id,
   occurred_at DESC)` index.

The `variant_id` and `stock_location_id` columns are real cross-service FKs
(`ON DELETE RESTRICT`) onto `product_variant` and `stock_location`, yet stay
semantically **opaque** to the inventory domain (no catalog entity import — the
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md) precedent).
The table takes no table-level collation override: its only string FK targets
`stock_location`, which sits at the MySQL server default, so the table stays at the
default to match (the `reservation` precedent; the FK-less `reference_id` never
hits a collation mismatch).

## Wire contracts

- `StockMovementTypeEnum` —
  `libs/contracts/inventory/enums/stock-movement-type.enum.ts`. A **wire** enum: it
  rides `StockMovementView`, the future audit query payload, and the future
  `inventory.stock-movement.recorded` event, so it lives in `libs/contracts`
  (unlike the lifecycle `ReservationStatusEnum`, which stays in the inventory
  `domain/` — the ADR-025 §7 split).
- `StockMovementView` —
  `libs/contracts/inventory/stock-movement/stock-movement.view.ts`. A class with
  `@ApiResponseProperty` (the `StockLevelView` style) projecting `id`, `variantId`,
  `stockLocationId`, `type`, signed `quantity`, the nullable `reasonCode` /
  `referenceType` / `referenceId` / `actorId`, and the ISO `occurredAt`.

Both are re-exported from `@retail-inventory-system/contracts`.

## What is deliberately absent

This is the ledger's foundation; the following land in later inventory work:

- Every movement **writer** — Release, Allocate, Cancel-Allocation, Receive,
  Adjust, Transfer — and the `inventory.stock-movement.recorded` event + its
  publisher method (which lands with its first emitter).
- The `inventory.stock-movement.list` RPC and the HTTP audit endpoint. The port's
  `listByVariant` method ships **now** so the read seam is complete, but nothing
  calls it yet.

## See also

- [ADR-030 — Reservation TTL aggregate and the stock-movement ledger](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
- [ADR-027 — `StockLevel` running totals and `StockLocation`](../../adr/027-stocklevel-running-totals-and-stocklocation.md)
  (the running totals that stay the balance authority)
- [ADR-029 — Category materialized path and polymorphic media](../../adr/029-category-materialized-path-and-polymorphic-media.md)
  (the polymorphic-no-FK reference precedent)
- [02 — The `Reservation` aggregate, table, and repository](02-reservation-aggregate-and-q2-q9.md)
  (the sibling foundation shipped alongside this ledger)
