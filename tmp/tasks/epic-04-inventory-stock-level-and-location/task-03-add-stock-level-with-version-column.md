---
epic: epic-04
task_number: 3
title: Add stock_level with the optimistic-concurrency version column
depends_on: [01, 02]
doc_deliverable: docs/implementation/04-inventory-stock-level-and-location/03-stocklevel-aggregate-and-version-column.md
---

# Task 03 — Add `stock_level` with the `@VersionColumn()` token

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Land the `stock_level` table and the TypeORM/repository plumbing around it, **shipping the `version` column from day one** so the OCC retrofit in `epic-07` and `epic-12` is a non-destructive additive change rather than a schema migration. The `StockLevel` domain class is added in this task as a **placeholder** with the constructor + getters wired, but the mutator methods (`receive(amount)`, `applySignedDelta(delta, reasonCode)`, `version` bump on every mutation) and the event-emission stubs are written end-to-end in task-04 — this task focuses on persistence so task-04 has a real row to load and save against. The repository methods land here too: `findByVariantAndLocation`, `findByVariant`, `save`, `incrementOnHand`, `applySignedDelta`.

The deferred reservation/allocation fields (`quantityAllocated`, `quantityReserved`) are present in the schema **with default `0`** from this task on. They are written but never mutated by epic-04 — every Receive/Adjust path increments `quantityOnHand` only. `epic-07` adds the use cases that mutate `quantityAllocated` and `quantityReserved`; this task ships the columns so that retrofit is non-destructive.

## Entry state assumed

Task-02 carryover present:

- `stock_location` table exists with the seeded `default-warehouse` row.
- `StockLocation` domain class + entity + mapper + repository methods on `StockTypeormRepository`.
- `STOCK_LOCATION_REPOSITORY` DI binding wired in `stock.module.ts`.
- `StockTypeormRepository` still implements the throwing-stub side for the `StockItem`-shaped repository methods (`findById`, `findBySku`, `aggregateForProduct`, `lockedTotalsByProduct`, `appendDeltas`, `save`).
- `stock_level` table does **not** exist.

## Scope

**In:**

- Placeholder domain class `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts`. The constructor + getters are wired here; the mutator methods are scaffolded with `// TODO: filled in by task-04` markers but compile. **Reason for the placeholder**: the mapper needs a domain type to round-trip; writing the placeholder here lets the mapper and the repository compile in the same task. Task-04 replaces the body with the full aggregate.
- New TypeORM entity `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-level.entity.ts` with the `@VersionColumn()` and the `(variantId, stockLocationId)` unique index.
- New mapper `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-level.mapper.ts`.
- Rewrite `IStockRepositoryPort` to its **new shape**: `findByVariantAndLocation`, `findByVariant`, `save`, `incrementOnHand`, `applySignedDelta`. The five old methods (`findById`/`findBySku`/`aggregateForProduct`/`lockedTotalsByProduct`/`appendDeltas`/the old `save(StockItem)`) are deleted from the interface — and from the throwing-stub class — in this task. Important: this is a breaking change to the port's surface area. The legacy use cases (`add-stock`, `get-stock`, `reserve-stock-for-order`) still exist on disk and import from this port; they will **stop compiling** at this point. Task-05 deletes them. To keep the build green between task-03 and task-05, this task **temporarily comments out the bodies** of those three use case files (`add-stock.use-case.ts`, `get-stock.use-case.ts`, `reserve-stock-for-order.use-case.ts`) and replaces them with `throw new Error('removed in epic-04 task-05')` while keeping the class declarations intact. The corresponding `*.spec.ts` files are marked `it.skip()` at the file level (`describe.skip(...)`).
- Implement the five new methods on `StockTypeormRepository`. The class now implements only `IStockRepositoryPort` (new shape) + `IStockLocationRepositoryPort`; the throwing-stub leftovers are removed.
- A new persistence spec `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/spec/stock-typeorm.repository.spec.ts` that exercises the new methods against an in-memory adapter / sqlite test setup (match the existing project test harness style — check `typeorm-transaction.adapter.spec.ts` for the established pattern).
- New migration `migrations/<timestamp>-CreateStockLevelTable.ts`.
- `stock.module.ts` updated to `DatabaseModule.forFeature([StockLocationEntity, StockLevelEntity])`.
- Doc deliverable `03-stocklevel-aggregate-and-version-column.md` — the **persistence half** (entity shape, `@VersionColumn()` rationale, unique index, FK-by-convention to `product_variant`). Task-04 appends the domain half.

**Out:**

- The full `StockLevel` aggregate (invariants on mutate, derived `available` getter, event-emission scaffolding) — task-04.
- New use cases (`receive-stock`, `adjust-stock`, `query-availability`) — task-05.
- The cache key bump — task-06.
- The variant-created consumer — task-07.

## `apps/inventory-microservice/.../domain/stock-level.model.ts` (placeholder)

```ts
export interface IStockLevelProps {
  id?: number | null;
  variantId: number;
  stockLocationId: string;
  quantityOnHand?: number;
  quantityAllocated?: number;
  quantityReserved?: number;
  version?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export class StockLevel {
  public readonly id: number | null;
  public readonly variantId: number;
  public readonly stockLocationId: string;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;
  // Mutable but only through the methods below (filled in by task-04).
  private _quantityOnHand: number;
  private _quantityAllocated: number;
  private _quantityReserved: number;
  private _version: number;

  constructor(props: IStockLevelProps) {
    // Invariants enforced by task-04. Today: trust the inputs because the
    // only constructor caller is the mapper, which loads from the DB.
    this.id = props.id ?? null;
    this.variantId = props.variantId;
    this.stockLocationId = props.stockLocationId;
    this._quantityOnHand = props.quantityOnHand ?? 0;
    this._quantityAllocated = props.quantityAllocated ?? 0;
    this._quantityReserved = props.quantityReserved ?? 0;
    this._version = props.version ?? 0;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public get quantityOnHand(): number { return this._quantityOnHand; }
  public get quantityAllocated(): number { return this._quantityAllocated; }
  public get quantityReserved(): number { return this._quantityReserved; }
  public get version(): number { return this._version; }
  public get available(): number {
    // Derived. Negative is structurally impossible after task-04's invariants
    // land, but `Math.max(0, …)` here is a defensive ceiling until then.
    return Math.max(0, this._quantityOnHand - this._quantityAllocated - this._quantityReserved);
  }

  // TODO(epic-04 task-04): the mutator methods land in task-04. Until then,
  // any caller of `receive(amount)` / `applySignedDelta(delta, reasonCode)`
  // gets a compile error because the symbol is not exported.
}
```

This placeholder shape is intentionally read-only externally — no mutator methods are exposed. The `quantityOnHand` / `quantityAllocated` / `quantityReserved` / `version` are *settable internally* by the placeholder constructor only (via `props`), so the repository's `incrementOnHand` / `applySignedDelta` methods (described below) can construct a fresh `StockLevel` after the DB-side `UPDATE` returns the new row state.

## `apps/inventory-microservice/.../infrastructure/persistence/stock-level.entity.ts`

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity('stock_level')
@Index('uq_stock_level_variant_location', ['variantId', 'stockLocationId'], { unique: true })
@Index('idx_stock_level_location', ['stockLocationId'])
export class StockLevel {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  public id: number;

  @Column({ type: 'int' })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'int', default: 0 })
  public quantityOnHand: number;

  @Column({ type: 'int', default: 0 })
  public quantityAllocated: number;

  @Column({ type: 'int', default: 0 })
  public quantityReserved: number;

  // The optimistic-concurrency token. Bumped on every successful UPDATE by
  // TypeORM's @VersionColumn() machinery. Conflict-detection lands in
  // epic-12 (currently unused; the column ships now so the epic-12 retrofit
  // is non-destructive).
  @VersionColumn({ type: 'int', default: 0 })
  public version: number;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
```

`variant_id` is **not** declared as a FK with `REFERENCES product_variant(id)` because `product_variant` lives in catalog and the two microservices own separate sets of migrations. Integrity is enforced at the application layer (`receive-stock` and `adjust-stock` use cases check that `findByVariantAndLocation` returns a row first) and is bootstrapped by the auto-init consumer in task-07.

A `CHECK` constraint on `quantity_on_hand >= 0` is added in the migration where the MySQL version supports it (8.0+, `CHECK` is enforced). On older MySQL it parses as a comment; the domain aggregate enforces the same invariant in either case from task-04 onward. Same for `quantity_allocated` and `quantity_reserved`.

## `apps/inventory-microservice/.../infrastructure/persistence/stock-level.mapper.ts`

```ts
import type { DeepPartial } from 'typeorm';

import { StockLevel as StockLevelDomain } from '../../domain';
import { StockLevel as StockLevelEntity } from './stock-level.entity';

export class StockLevelMapper {
  public static toDomain(entity: StockLevelEntity): StockLevelDomain {
    return new StockLevelDomain({
      id: entity.id,
      variantId: entity.variantId,
      stockLocationId: entity.stockLocationId,
      quantityOnHand: entity.quantityOnHand,
      quantityAllocated: entity.quantityAllocated,
      quantityReserved: entity.quantityReserved,
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  public static toEntity(domain: StockLevelDomain): DeepPartial<StockLevelEntity> {
    return {
      ...(domain.id !== null ? { id: domain.id } : {}),
      variantId: domain.variantId,
      stockLocationId: domain.stockLocationId,
      quantityOnHand: domain.quantityOnHand,
      quantityAllocated: domain.quantityAllocated,
      quantityReserved: domain.quantityReserved,
      version: domain.version,
    };
  }
}
```

Same name-aliasing convention as the `StockLocation` pair from task-02.

## `IStockRepositoryPort` rewrite — concrete shape

```ts
import { StockLevel } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

export interface IStockLevelFindByVariantPayload {
  variantId: number;
  correlationId?: string;
}

export interface IStockLevelIncrementPayload {
  variantId: number;
  stockLocationId: string;
  amount: number; // strictly positive
  correlationId?: string;
}

export interface IStockLevelSignedDeltaPayload {
  variantId: number;
  stockLocationId: string;
  delta: number; // signed
  reasonCode: string;
  correlationId?: string;
}

export interface IStockRepositoryPort {
  findByVariantAndLocation(
    variantId: number,
    stockLocationId: string,
    scope?: ITransactionScope,
  ): Promise<StockLevel | null>;

  findByVariant(
    payload: IStockLevelFindByVariantPayload,
    scope?: ITransactionScope,
  ): Promise<StockLevel[]>;

  save(level: StockLevel, scope?: ITransactionScope): Promise<StockLevel>;

  // Atomic SQL UPDATE (no read-modify-write). Returns the post-update row.
  // The CHECK constraint (or the equivalent guard inside the UPDATE WHERE
  // clause) prevents `quantity_on_hand` from going negative on a signed
  // delta; the port rejects the call with a domain-layer error if zero rows
  // were affected.
  incrementOnHand(
    payload: IStockLevelIncrementPayload,
    scope?: ITransactionScope,
  ): Promise<StockLevel>;

  applySignedDelta(
    payload: IStockLevelSignedDeltaPayload,
    scope?: ITransactionScope,
  ): Promise<StockLevel>;
}
```

The `incrementOnHand` and `applySignedDelta` methods are written here as **atomic SQL UPDATEs** (one round-trip; the `WHERE quantity_on_hand + :delta >= 0` clause keeps it correct under concurrent writers without needing pessimistic locking). The post-update row is read back with a `RETURNING`-style follow-up (MySQL 8 supports `SELECT … FOR UPDATE` inside the same transaction; older MySQL needs a second `SELECT` — match the project's `mysql2` driver version). The `@VersionColumn()` is bumped by TypeORM on the UPDATE; the returned row carries the new `version`.

The throwing-stub class loses its `findById` / `findBySku` / `aggregateForProduct` / `lockedTotalsByProduct` / `appendDeltas` / `save(StockItem)` methods entirely — they are not part of the new port surface. The class's `implements IStockRepositoryPort` clause now points at the new interface; no method is left over from the pre-epic-04 era.

## Legacy use case files — temporary stubs

Because tasks 03 → 05 span multiple commits, the legacy use case files (`add-stock.use-case.ts`, `get-stock.use-case.ts`, `reserve-stock-for-order.use-case.ts`) lose their port methods when this task reshapes `IStockRepositoryPort`. To keep the build compiling between task-03 and task-05, replace each file's `execute(…)` body with:

```ts
throw new Error(
  '<UseCaseName> was removed by epic-04 task-03 ahead of task-05 cleanup. ' +
    'This use case has no body during the task-03 → task-05 transition.',
);
```

Their constructors no longer take `STOCK_REPOSITORY` (the port shape changed). Replace each constructor signature with `constructor() {}` and add a class-level comment pointing at task-05 for the deletion. Their `*.spec.ts` files are marked `describe.skip(...)` so the test runner doesn't report failures for now-irrelevant assertions.

The corresponding `@MessagePattern` handlers in `stock.controller.ts` are similarly defanged in this task — replace each handler body with `throw new Error(...)` and add the same task-05 cleanup comment. Task-05 deletes the handlers, the use case files, and the spec files in one pass.

`test-doubles.ts` is updated: the `IStockRepositoryPort` test double is rewritten to satisfy the new five-method surface. The double is consumed by the cache spec (`stock.cache.spec.ts`) — that spec is left untouched here; task-06 rewrites it.

## Migration: `migrations/<timestamp>-CreateStockLevelTable.ts`

`up()`:

1. `CREATE TABLE stock_level` with the column shape from the entity above.
2. `CREATE UNIQUE INDEX uq_stock_level_variant_location ON stock_level (variant_id, stock_location_id)`.
3. `CREATE INDEX idx_stock_level_location ON stock_level (stock_location_id)`.
4. (MySQL 8 only) `ALTER TABLE stock_level ADD CONSTRAINT chk_stock_level_on_hand_nonneg CHECK (quantity_on_hand >= 0)`. Same for `quantity_allocated` and `quantity_reserved`. On MySQL 5.7 this parses as a comment — the domain aggregate (task-04) carries the same invariant so behavior is identical.

`down()` is a no-op (forward-only).

The table is **created empty**. No seed rows are inserted by this migration — `stock_level` is populated either by the auto-init consumer (task-07, on `catalog.variant.created`) or by the test seed (task-10, which deterministically inserts a 100-unit row per seeded variant at the default warehouse so e2e tests don't depend on the RMQ consumer being up).

## `stock.module.ts` update

```ts
imports: [
  DatabaseModule.forFeature([StockLocationEntity, StockLevelEntity]),
  MicroserviceClientNotificationModule,
],
providers: [
  StockTypeormRepository,
  { provide: STOCK_REPOSITORY, useExisting: StockTypeormRepository },
  { provide: STOCK_LOCATION_REPOSITORY, useExisting: StockTypeormRepository },

  // StockCache + StockRabbitmqPublisher + TypeormTransactionAdapter providers — unchanged.

  // The three legacy use case providers are still listed (they are not deleted
  // until task-05). Their `execute()` bodies throw; the @MessagePattern wires
  // in `stock.controller.ts` are similarly defanged.
  AddStockUseCase,
  GetStockUseCase,
  ReserveStockForOrderUseCase,
]
```

## Files to add

- `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts` (placeholder)
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-level.entity.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-level.mapper.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/spec/stock-typeorm.repository.spec.ts` (new — old spec was deleted in task-01)
- `migrations/<timestamp>-CreateStockLevelTable.ts`
- `docs/implementation/04-inventory-stock-level-and-location/03-stocklevel-aggregate-and-version-column.md` (persistence half — task-04 appends domain half)

## Files to modify

- `apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts` — rewritten to the five-method shape.
- `apps/inventory-microservice/src/modules/stock/application/ports/index.ts` — re-export the new payload interfaces.
- `apps/inventory-microservice/src/modules/stock/domain/index.ts` — export `StockLevel` (and stop exporting `StockItem` only if the placeholder StockLevel is the only domain reference left; the `StockItem` model is still on disk through this task and is renamed in task-04).
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts` — five new method implementations; the throwing-stub leftovers gone.
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/index.ts` — re-export the new entity + mapper.
- `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts` — `DatabaseModule.forFeature([StockLocationEntity, StockLevelEntity])`.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/add-stock.use-case.ts` — body replaced by the temporary stub described above.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts` — same.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts` — same.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts` — rewritten port double.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/add-stock.use-case.spec.ts` — `describe.skip(...)`.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/get-stock.use-case.spec.ts` — `describe.skip(...)`.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/reserve-stock-for-order.use-case.spec.ts` — `describe.skip(...)`.
- `apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts` — `@MessagePattern` handler bodies replaced by the throwing stub.

## Files to delete

None in this task. The legacy use case files are stubbed, not deleted; task-05 owns the deletion.

## Tests

- The new `stock-typeorm.repository.spec.ts` is the only new spec added in this task. It exercises `findByVariantAndLocation` (hit + miss), `findByVariant` (multi-location list), `save` (insert + update), `incrementOnHand` (happy path + concurrent-writer race using two transactions), `applySignedDelta` (happy path + zero-rows-affected case when the signed delta would drive `quantityOnHand` negative).
- The placeholder `stock-level.model.ts` does not get its own spec yet — task-04 adds the full domain spec.
- `stock-location.model.spec.ts` from task-02 continues to pass.
- The three `describe.skip(...)`'d use-case specs are silent (skipped, not failing).
- `yarn build:inventory-microservice` succeeds.
- `yarn migration:run` against the post-task-02 DB creates the `stock_level` table with the unique + secondary indexes and the (MySQL 8) CHECK constraints.

## Doc deliverable

Write the **persistence half** of `docs/implementation/04-inventory-stock-level-and-location/03-stocklevel-aggregate-and-version-column.md`. Target ~140 lines now; task-04 appends ~120 lines for the domain half. Sections this task writes:

1. **Why running totals, not a delta ledger.** Restate the epic's rationale: reads do not pay the `SUM` cost; the no-oversell invariant has a natural home on the row; OCC has a column to attach to. Cross-link doc 01 (which covered "why the ledger goes away" from the inverse angle).
2. **The column shape.** Table with each column, its type, default, and one-line semantic note. The `variant_id` row notes "cross-service FK by convention — not declared with REFERENCES; see §FK strategy".
3. **`@VersionColumn()`: why it ships now.** The OCC enforcement lives in `epic-07` (where Reservation arrives — the no-oversell race surface) and is hardened in `epic-12` (retry policy + integration tests). The column ships in this epic so that retrofit is purely additive (epic-07 starts using the existing column; no schema change). What `@VersionColumn()` does mechanically (TypeORM increments on every `save()` UPDATE; the SQL `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?` shape is the retrofit target — not used yet in this epic).
4. **The unique `(variant_id, stock_location_id)` index.** Why it is a unique index, not a composite primary key (BIGINT surrogate key is friendlier for repository ergonomics; the unique index gives the invariant without making the row immobile). The `INSERT ... ON DUPLICATE KEY UPDATE` semantics this enables (the auto-init consumer in task-07 leans on this for idempotency).
5. **The cross-service FK strategy.** `variant_id` is an `INT` column with no `REFERENCES product_variant(id)` SQL clause. Why: catalog and inventory each own their migration sets; ADR-019 treats each microservice's tables as schema-private even when they share a MySQL database today (and even more strictly when they don't, post-split). Application-layer enforcement: (a) `receive-stock` / `adjust-stock` use cases check `findByVariantAndLocation` is non-null before mutating; (b) the auto-init consumer (task-07) inserts the row on `catalog.variant.created`, so any later operation has a row to find; (c) deletion of a `ProductVariant` on the catalog side is forbidden by epic-02's design (variants are soft-archived, never deleted), so no orphan-row scenario can land via the catalog code paths.
6. **The atomic UPDATE pattern.** Why `incrementOnHand` / `applySignedDelta` are single SQL UPDATEs rather than read-modify-write. The `WHERE quantity_on_hand + :delta >= 0` clause as a substitute for a CHECK constraint on MySQL versions that don't enforce CHECK; zero-rows-affected is the signal the application layer translates into `409 Conflict`.
7. **Defaults: `quantityAllocated` / `quantityReserved` ship at 0.** Both columns are present and writable from this task onward but no epic-04 code path mutates them. Forward link to `epic-07` which adds the Reservation + Allocation flows.
8. **What this task did NOT do.** Forward links to task-04 (the full aggregate, mutator methods, event-emission stubs), task-05 (the use cases that wire the repository to actual user-driven operations), task-06 (the cache key bump that aligns the read payload with the new shape), task-07 (the consumer that initializes rows on variant creation).

Task-04 appends a closing **Domain Aggregate** section (invariants on mutate, derived `available` getter, the `receive(amount)` / `applySignedDelta(delta, reasonCode)` method contracts, the per-mutation `version` bump from the aggregate's point of view, the event-emission scaffolding even though the publisher binding lives in task-08).

## Carryover produced (consumed by task-04 onward)

- `stock_level` table exists in MySQL with the unique + secondary indexes; the `version` column ships from this commit.
- `StockLevel` placeholder domain class on disk; the mapper round-trips the entity through it.
- `IStockRepositoryPort` has the new five-method shape; `StockTypeormRepository` implements it.
- The three legacy use case files are temporarily stubbed; their specs are `describe.skip(...)`'d. Task-05 deletes all of them.
- The controller's `@MessagePattern` handler bodies throw the same temporary stub error.
- Doc `03-stocklevel-aggregate-and-version-column.md` exists with the persistence half written.

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; the new persistence spec is green; the three `describe.skip(...)`'d use-case specs are reported as skipped (not failing).
- [ ] `yarn build:inventory-microservice` succeeds.
- [ ] `yarn migration:run` against a post-task-02 DB creates the `stock_level` table; `SHOW INDEX FROM stock_level` reports the unique `(variant_id, stock_location_id)` index and the secondary `stock_location_id` index.
- [ ] On MySQL 8: `mysql -e "INSERT INTO stock_level (variant_id, stock_location_id, quantity_on_hand) VALUES (1, 'default-warehouse', -1)"` is rejected by the CHECK constraint.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `03-stocklevel-aggregate-and-version-column.md` exists with the persistence-half sections above filled.
