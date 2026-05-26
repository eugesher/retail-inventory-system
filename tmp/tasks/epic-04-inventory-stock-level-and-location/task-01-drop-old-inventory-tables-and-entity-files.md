---
epic: epic-04
task_number: 1
title: Drop the old inventory tables + entity files; park the repository in a throwing-stub state
depends_on: []
doc_deliverable: docs/implementation/epic-04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md
---

# Task 01 — Drop the old inventory tables + entity files

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Remove the entire ledger-as-source schema from the inventory microservice: drop the four MySQL tables (`product_stock`, `product_stock_action`, `storage`, `product`), delete the four TypeORM entity files plus the now-orphaned mapper, and **rewrite `StockTypeormRepository` into a method-by-method throwing stub** so the build keeps compiling while tasks 02–05 reassemble the real implementation behind it. Delete the domain `storage.model.ts` (no replacement in domain — `StockLocation` lives in `domain/stock-location.model.ts` per task-02, with a slightly different shape).

This task ships a **deliberately broken intermediate state**. Between this task and task-05, the inventory microservice will not be able to satisfy any of the legacy RPCs (`inventory.product-stock.get`, `inventory.order.confirm`); task-05 finishes the cleanup by deleting their `@MessagePattern` handlers and their corresponding use cases (`add-stock.use-case.ts`, `reserve-stock-for-order.use-case.ts`, `get-stock.use-case.ts`). The throwing-stub state is intentional, not accidental — any caller that hits an old RPC during this window receives a deterministic "removed in epic-04 task-N" error frame rather than a `TypeError` from a half-deleted symbol.

## Entry state assumed

Epic-02 is complete on disk. Specifically:

- `apps/catalog-microservice/` exists and has been emitting `catalog.variant.created` since epic-02 task-03.
- The inventory-side `product` table has **possibly already been dropped** by epic-02 task-08 (`DropInventoryProductTable`). This task must detect both branches and behave correctly either way — see §"Detect prior `product` drop" below.
- `apps/inventory-microservice/src/modules/stock/` carries the four old entities and the `StockTypeormRepository` from the architecture migration (RIS-32 / RIS-40 era).
- `libs/messaging/routing-keys.constants.ts` still lists `INVENTORY_PRODUCT_STOCK_GET` and `INVENTORY_ORDER_CONFIRM`. These constants remain valid through this task — task-08 retires them and reshapes `INVENTORY_ORDER_CONFIRM` into a deprecation handler.
- `libs/cache/cache-keys.ts` still exposes `inventoryStockPrefix(productId, …)` / `inventoryStock(productId, …)` / `inventoryStockLegacyPrefix(productId)` / `productStockPrefix(productId)` / `productStock(productId, …)`. None of these are touched here — task-06 owns the version bump.

## Scope

**In:**

- A new migration `migrations/<timestamp>-DropOldInventoryTables.ts` that drops `product_stock`, `product_stock_action`, `storage`, and (conditionally) `product`. Idempotent — uses `DROP TABLE IF EXISTS` so a half-rolled-back environment can still run it.
- Delete four entity .ts files under `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/`: `product.entity.ts`, `product-stock.entity.ts`, `product-stock-action.entity.ts`, `storage.entity.ts`.
- Delete the now-orphaned `stock-item.mapper.ts` (it maps `ProductStock` to `StockItem` — both sides go away in this epic; the new `StockLevel` mapper lands in task-03).
- Delete the domain `apps/inventory-microservice/src/modules/stock/domain/storage.model.ts` and its spec `domain/spec/storage.model.spec.ts`. The new `StockLocation` aggregate is task-02; it has a richer shape (`code`, `type`, `address`, `gln`, `active`) and is therefore not a rename — it is a fresh model.
- Rewrite `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts` into a **throwing stub**: every public method (the six surfaced through `IStockRepositoryPort`) throws a single sentinel error `InventoryRepositoryStubError('<methodName> is unavailable until epic-04 task-N has landed', { method, taskNumber })` with the carryover-task-number embedded so a runtime hit during this transition window produces a self-describing failure.
- Update `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts`: shrink `DatabaseModule.forFeature([Product, ProductStock, ProductStockAction, Storage])` to `DatabaseModule.forFeature([])` — task-02 swaps it to `[StockLocation]` and task-03 to `[StockLocation, StockLevel]`.
- Update `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/index.ts` to remove the now-deleted exports.
- Update `apps/inventory-microservice/src/modules/stock/domain/index.ts` to remove the now-deleted `Storage` export. The `StockItem` export stays — it is renamed in task-04, not here.
- Update `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts` if it constructs `Storage` instances directly; rename those to `unknown` casts with a TODO referencing task-02. (Inspect the file; if it does not reference `Storage`, no change is required.)
- Doc deliverable `01-old-tables-dropped-and-new-schema.md` under `docs/implementation/epic-04-inventory-stock-level-and-location/` — the introductory half. Task-10 appends the cumulative "after" snapshot once the new schema is fully in place.

**Out:**

- Adding the new entities — tasks 02 + 03.
- Rewriting the use cases — task-05. The existing `add-stock.use-case.ts`, `get-stock.use-case.ts`, and `reserve-stock-for-order.use-case.ts` survive this task untouched on disk. They will fail at runtime against the throwing stub, but they still type-check (the port interface they import from is intact) and their specs continue to compile (they use the test-double from `spec/test-doubles.ts`, not the throwing stub).
- Renaming `StockItem` to `StockLevel` — task-04.
- Touching `libs/cache/cache-keys.ts` — task-06.
- Touching the api-gateway side — task-09.

## Detect prior `product` drop

The inventory `product` table may already be gone if epic-02 task-08 ran before this epic. The migration must handle both cases:

```ts
// Pseudocode — concrete TypeORM QueryRunner syntax below.
public async up(qr: QueryRunner): Promise<void> {
  await qr.dropTable('product_stock', /* ifExist */ true);
  await qr.dropTable('product_stock_action', true);
  await qr.dropTable('storage', true);
  // The inventory-side `product` table is dropped here only if epic-02 task-08
  // did not already drop it. `dropTable(..., true)` is a no-op when the table
  // is absent, so an unconditional call is safe and idempotent.
  await qr.dropTable('product', true);
}

public async down(qr: QueryRunner): Promise<void> {
  // Down is intentionally a no-op. The original `Create*` migrations in
  // `1772600000000-InitStarterEntities.ts` would recreate the dropped tables
  // if rolled forward from zero; rolling *back* this single migration would
  // not have schemas in hand to restore (the entity classes are deleted).
  // Production deploys are forward-only by ADR-019 §"Rollback policy" — this
  // is documented in the doc deliverable.
}
```

The `down()` no-op is intentional and worth a code comment plus a paragraph in the doc deliverable. Forward-only migration is the project policy (see `CLAUDE.md` §"Migrations").

## Throwing-stub shape for `StockTypeormRepository`

The file is rewritten end-to-end. The class still implements `IStockRepositoryPort` (so DI wiring keeps compiling), but every method body throws. Concrete shape:

```ts
import { Injectable } from '@nestjs/common';

import type { StockItem } from '../../domain';
import type {
  IStockAggregateForProductPayload,
  IStockAppendDeltasPayload,
  IStockLockedTotalsPayload,
  IStockRepositoryPort,
  ITransactionScope,
} from '../../application/ports';

// Sentinel error class so runtime failures during the epic-04 transition
// window are self-describing in logs. Removed when task-05 deletes the
// methods this class used to back.
export class InventoryRepositoryStubError extends Error {
  constructor(method: string, taskNumber: number) {
    super(
      `StockTypeormRepository.${method} is unavailable: the underlying ` +
        `tables (product_stock, storage) were dropped by epic-04 task-01. ` +
        `The real implementation lands in epic-04 task-${taskNumber}. ` +
        `If you are reading this, an old caller was not removed in lockstep.`,
    );
    this.name = 'InventoryRepositoryStubError';
  }
}

@Injectable()
export class StockTypeormRepository implements IStockRepositoryPort {
  public findById(_id: number): Promise<StockItem | null> {
    throw new InventoryRepositoryStubError('findById', 3);
  }
  public findBySku(_sku: string): Promise<StockItem | null> {
    throw new InventoryRepositoryStubError('findBySku', 3);
  }
  public aggregateForProduct(
    _payload: IStockAggregateForProductPayload,
    _scope?: ITransactionScope,
  ): Promise<never> {
    throw new InventoryRepositoryStubError('aggregateForProduct', 5);
  }
  public lockedTotalsByProduct(
    _payload: IStockLockedTotalsPayload,
    _scope: ITransactionScope,
  ): Promise<Map<number, number>> {
    throw new InventoryRepositoryStubError('lockedTotalsByProduct', 5);
  }
  public appendDeltas(
    _payload: IStockAppendDeltasPayload,
    _scope?: ITransactionScope,
  ): Promise<void> {
    throw new InventoryRepositoryStubError('appendDeltas', 5);
  }
  public save(_stockItem: StockItem): Promise<StockItem> {
    throw new InventoryRepositoryStubError('save', 3);
  }
}
```

Note the per-method `taskNumber` argument — readers of a runtime stack trace get told exactly which task fills in the gap. Task-03 fills in `findById` / `findBySku` / `save` (the per-row variantId-keyed reads). Task-05 fills in `aggregateForProduct` / `lockedTotalsByProduct` / `appendDeltas` (the use-case-driven entry points are then rewritten — `appendDeltas` is in fact deleted entirely, replaced by `incrementOnHand` / `applySignedDelta`; the stub line is removed alongside the deletion).

`BaseTypeormRepository` is no longer extended. The stub class is intentionally bare — it does not need the `Repository<>` injection that `BaseTypeormRepository` was carrying. The constructor goes away.

## `apps/inventory-microservice/.../infrastructure/persistence/spec/stock-typeorm.repository.spec.ts`

This spec exercises the old `ProductStock`-backed implementation against an in-memory test repository. It is **deleted in this task**, not adapted. Task-03 (and task-05) write a fresh spec against the real new implementation; the carry-over of test scaffolding is not worth the cognitive load given how different the shape is.

## `apps/inventory-microservice/.../infrastructure/persistence/spec/typeorm-transaction.adapter.spec.ts`

This spec covers the `ITransactionPort` adapter, which is **not affected** by this epic — the unit-of-work adapter is per-EntityManager, not per-entity. Leave it untouched.

## Files to add

- `migrations/<timestamp>-DropOldInventoryTables.ts` — the migration described above.
- `docs/implementation/epic-04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md` — introductory half; task-10 appends the post-state snapshot.

## Files to modify

- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts` — rewritten end-to-end into the throwing stub.
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/index.ts` — drop the deleted-entity exports; keep the repository export.
- `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts` — `DatabaseModule.forFeature([])` (empty).
- `apps/inventory-microservice/src/modules/stock/domain/index.ts` — drop the `Storage` export.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts` — inspect; remove any `Storage` construction.

## Files to delete

- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock-action.entity.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/storage.entity.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-item.mapper.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/spec/stock-typeorm.repository.spec.ts`
- `apps/inventory-microservice/src/modules/stock/domain/storage.model.ts`
- `apps/inventory-microservice/src/modules/stock/domain/spec/storage.model.spec.ts`

## Tests

- The deleted spec count is two (`stock-typeorm.repository.spec.ts`, `storage.model.spec.ts`). No new specs are added in this task.
- The remaining specs (`stock-item.model.spec.ts`, `add-stock.use-case.spec.ts`, `get-stock.use-case.spec.ts`, `reserve-stock-for-order.use-case.spec.ts`, `stock.cache.spec.ts`) continue to pass — none of them depend on the dropped TypeORM entities at the type level; they import from the domain layer (`StockItem` is intact in this task) and from the port interfaces.
- `yarn build:inventory-microservice` must succeed — the throwing stub still satisfies `IStockRepositoryPort` structurally.
- The boot smoke test must succeed: `docker compose up -d mysql rabbitmq redis && yarn migration:run && yarn start:dev:inventory-microservice`. The service starts; any RPC request still produces a `InventoryRepositoryStubError` until task-05 lands. A handler-level catch in `stock.controller.ts` is not added — the un-rewritten controller will let the error propagate to the RMQ caller, which is the desired observable behavior during this transition.

## Doc deliverable

Write `docs/implementation/epic-04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md` (introductory half — target ~120 lines now; task-10 appends ~30 more lines for the after-snapshot). Sections this task writes:

1. **Why the ledger-as-source goes away.** Restate the epic's "Goal" rationale: the old `product_stock` table was a typed-delta ledger (`actionId` + signed `quantity` rows, aggregated by `SUM` at read time). The walking-skeleton report concluded that running-totals on `StockLevel` + a separate `StockMovement` ledger (deferred to epic-07) is the universal-core shape — not a ledger as the read source. Two-table > one-table because (a) reads do not pay the aggregate cost, (b) the no-oversell invariant has a natural home on `StockLevel.quantityOnHand - quantityAllocated - quantityReserved`, (c) optimistic concurrency has a `version` column to attach to.
2. **What got dropped.** Bullet list with the four tables + the four entity files + the orphaned mapper. Cite each row by file path and explain why the file goes away (e.g. `product.entity.ts` is the inventory-side stub of the catalog `Product` from before the split; epic-02 owns the real `Product`).
3. **The forward-only `down()` no-op.** Cite `CLAUDE.md` §"Migrations". A rollback past this migration would require schemas the entity files no longer carry. The project's deploy policy is forward-only; the doc explicitly says "if a deploy goes wrong, fix forward, do not roll back".
4. **The throwing-stub interlude.** Why `StockTypeormRepository` is not deleted outright. (Answer: the DI graph references it, and tasks 02–04 will rebuild it incrementally; tearing out the binding now and then re-adding it would force `stock.module.ts` to be modified four times instead of once.) Cite the per-method `taskNumber` argument and what runtime behavior to expect.
5. **The `product` table branching.** Brief paragraph: if epic-02 task-08 already ran, the `DROP TABLE IF EXISTS product` is a no-op; if it did not, this migration owns the drop. Either way the entity file is gone.
6. **Forward links.** Doc 02 covers the new `StockLocation` table + the default-warehouse auto-provision; doc 03 covers `StockLevel` + the `version` column.

Task-10 appends a closing section: the before/after schema diagram (mermaid or ASCII) and a list of which surfaces are now `variantId`-keyed (the table column, the cache key, the HTTP path, the RMQ payload).

## Carryover produced (consumed by task-02 onward)

- The four old tables are gone from MySQL.
- The four entity files + the orphaned mapper are gone from disk.
- `StockTypeormRepository` is a throwing stub. Its constructor takes no arguments and the DI binding `{ provide: STOCK_REPOSITORY, useExisting: StockTypeormRepository }` still resolves.
- `DatabaseModule.forFeature([])` in `stock.module.ts` — ready for task-02 to add `StockLocation`.
- Doc `01-old-tables-dropped-and-new-schema.md` exists with the introductory half written.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); no unused-import warnings in the rewritten files.
- [ ] `yarn test:unit` passes; the surviving specs are green; no new specs are added or skipped.
- [ ] `yarn build:inventory-microservice` succeeds.
- [ ] `docker compose up -d && yarn migration:run` runs the new `DropOldInventoryTables` migration without error; subsequent `mysql -e "SHOW TABLES"` shows none of `product`, `product_stock`, `product_stock_action`, `storage`.
- [ ] `yarn start:dev:inventory-microservice` boots; a sample RPC call against `inventory.product-stock.get` produces an `InventoryRepositoryStubError` whose message names task-05.
- [ ] `git ls-files apps/inventory-microservice/src/modules/stock/infrastructure/persistence/` shows only `stock-typeorm.repository.ts`, `typeorm-transaction.adapter.ts`, `typeorm-transaction.adapter.spec.ts`, `index.ts` — and no `*.entity.ts` files.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `01-old-tables-dropped-and-new-schema.md` exists with the six sections above filled.
