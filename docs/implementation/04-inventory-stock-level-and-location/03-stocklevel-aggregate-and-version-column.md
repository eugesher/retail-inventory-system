# The `StockLevel` aggregate and the `version` column

`StockLevel` is the inventory write model: per-location running totals for one
catalog variant. It is a framework-free domain class (no `@nestjs/*`, no
`typeorm`, no `class-validator` — [ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md)),
living at `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts`.

## Fields and the `available` getter

A level holds three maintained quantities — `quantityOnHand`,
`quantityAllocated`, `quantityReserved` — plus `variantId`, `stockLocationId`, a
nullable `id`, and the `version` token. The sellable count is a pure getter:

```
available = quantityOnHand − quantityAllocated − quantityReserved
```

`onHand` is what is physically present; `allocated` is what is committed to
picks; `reserved` is what is held against carts/orders. `available` can be
computed at any time without touching the database — it is a function of the row
already loaded.

## Non-negative invariants

The constructor rejects any of the three quantities (and `version`) that is not
a non-negative integer, throwing a plain `Error`. (At this foundation's time the
inventory context had no `DomainException` subclass at all. Since the Receive/Adjust
write operations introduced `InventoryDomainException`
([06-receive-and-adjust-use-cases.md](06-receive-and-adjust-use-cases.md)), the
constructor's plain `Error` is a *deliberate* choice rather than an absence: a
non-negative-integer breach in the constructor is **counter drift** — a state reachable
only through an internal bug — so it stays a plain `Error` that surfaces as a 500,
while a state a caller can legitimately reach is a typed exception. See the
`apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts` header.)
The same non-negativity is also backed at the database by three `CHECK`
constraints on `stock_level` (MySQL 8.4 enforces `CHECK`), so the invariant holds
in both layers.

> If a future deployment ran a MySQL build that did not enforce `CHECK`
> constraints, the non-negativity would still be guaranteed by the aggregate
> constructor and `changeOnHand` (below); the `CHECK` clauses would degrade to
> documentation. On the MySQL 8.4 this project targets, they are enforced.

## `changeOnHand` is the only mutation — and it bumps `version`

This foundation needs exactly one mutation: `changeOnHand(delta)`. It applies a
signed delta to `quantityOnHand`, **rejects a result below zero**, and
**increments `version`**. (At epic time the below-zero rejection threw a plain
`Error`; since the Receive/Adjust operations introduced `InventoryDomainException`
([06-receive-and-adjust-use-cases.md](06-receive-and-adjust-use-cases.md)) it throws
a typed `InventoryDomainException` with code `STOCK_RESULT_NEGATIVE`, which the
presentation filter maps to a **409** —
`apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts:96`. The
non-integer `delta` guard on the same method is still a plain `Error`, being drift, not
a reachable business state.)

```ts
level.changeOnHand(+5); // receive
level.changeOnHand(-2); // ship; version advances on each call
```

`allocate` / `reserve` / `release` are deliberately **not** present *at this
foundation* — shipping them here would have been dead, untested code. Since the
inventory-reservation capability ([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md))
they have landed: `StockLevel` today also carries `reserve`, `releaseReserved`,
`allocateFromReserved`, `allocateDirect`, `releaseAllocated`, and `commitSale`
(`apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts:113`
onward), each bumping `version` exactly once. A
`StockLevel.initialAt(variantId, stockLocationId)` factory returns a zeroed level at
`version 0`, used by the auto-init consumer and lazy-init paths in later capabilities.

The unit spec asserts each invariant: non-negative construction, the `available`
arithmetic, the negative-result rejection, that `version` increments on **every**
`changeOnHand`, and that `initialAt` yields all-zeros at `version 0`.

## The `version` optimistic-concurrency token, and why it ships now

`stock_level` carries a `version` column mapped with TypeORM's
`@VersionColumn()`; TypeORM owns the persisted value (incremented on each managed
save), while the aggregate advances its own in-memory `version` on every mutation
so the bump is observable in the unit test.

The invariant `version` ultimately guards is **no-oversell**: under concurrent
reservation/allocation, two transactions must not both commit against the same
on-hand and drive `available` negative. That enforcement — a compare-and-set on
`version` (optimistic locking) — has since arrived. The Receive/Adjust writes
themselves now persist through `persistStockLevelChange(level, expectedVersion)`
inside a bounded optimistic retry (`runWithStockWriteRetry`,
[ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) /
[ADR-045](../../adr/045-one-occ-retry-protocol.md)), and the reservation-capability
writes ([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md))
build on the same protocol. At this foundation, nothing read or wrote the column yet —
it shipped defaulted to `0`, ready for the guard.

The column ships now anyway because adding an optimistic-lock column to a
**populated** table later is a destructive `ALTER TABLE`. Shipping `version` (and
its `@VersionColumn()` mapping) from the start makes the future retrofit
non-destructive: the column is already there, defaulted to `0`, ready for the
guard to start reading and writing it. This is the same forward-compatibility
reasoning that motivates the schema as a whole.

See [01-old-tables-dropped-and-new-schema.md](01-old-tables-dropped-and-new-schema.md)
for the table definition and
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md) for the
decision record.
