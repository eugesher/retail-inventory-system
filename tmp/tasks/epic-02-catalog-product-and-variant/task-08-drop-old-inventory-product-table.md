---
epic: epic-02
task_number: 8
title: Drop the obsolete inventory-microservice product table via a migration
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06, task-07]
doc_deliverable: —
---

# Task 08 — Drop the obsolete inventory-microservice `product` table

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Remove the three-column `product` table (`id`, `name`, `created_at`/`updated_at`) that the inventory-microservice introduced in the pre-`epic-02` schema. The new catalog-microservice's `product` + `product_variant` tables (created in task-02) are the source of truth from here on. The inventory bounded context's reads/writes shift from `productId` to `variantId` — but that shift is **owned by `epic-04`**; this task only drops the obsolete table and explicitly flags the resulting dangling FK reference in the inventory adapter for `epic-04` to reshape.

No domain code, no use case, no entity is changed by this task — that's deliberate. The table is dropped, the inventory app keeps booting (the `ProductEntity` import on the inventory side does not fail at boot because TypeORM resolves entities via `DatabaseModule.forRoot([...])`; the FK error only surfaces at the first runtime query against the missing table), and `epic-04` is the place where the inventory schema is actually reshaped around variants.

## Entry state assumed

Tasks 1–7 carryover present:

- `catalog-microservice` is live; `Product` + `ProductVariant` tables exist; the seven HTTP endpoints work end-to-end.
- The inventory-microservice still references the old `product` table via its `ProductEntity` (`apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts`) and its `stock-typeorm.repository.ts` FK relations.
- The retail-microservice has never had a `product` table.
- `http/catalog.http` exists.

## Scope

**In:**

- A single migration `migrations/<ts>-DropInventoryProductTable.ts`:
  - `up`: `DROP TABLE IF EXISTS product;` — but this collides with the new catalog `product` table introduced by task-02's migration. **Critical detail**: the catalog migration runs first (earlier timestamp); the inventory product table is the same name. The right approach depends on schema layout:
    - **Option A (shared schema)**: the two `product` tables would have collided at task-02's `migration:run` already. If they did, task-02 is broken. Cross-check by inspecting `1772600000000-InitStarterEntities.ts` and `1774134626155-AddOrderProductIdToProductStock.ts`. The likely actual reality is that the inventory side's `product` table is the same `product` table that exists today, and task-02's migration would have errored on `CREATE TABLE product` because the table already exists.
    - **Option B (corrected sequencing)**: task-02's migration is renamed/reordered so its `CREATE TABLE product` only runs after the old `product` has been dropped, OR task-02 uses a different table name for the new catalog product table (e.g. `catalog_product`), OR the old `product` table is renamed in this task before the new one is created.
  - **Decision for the decomposition (carryover-friendly)**: rename the new catalog tables in task-02's migration to `catalog_product` and `catalog_variant`. That avoids the collision entirely. **Update task-02 if this decomposition is acted upon — the persistence doc deliverable should call out the `catalog_` prefix convention** (it's documented as a Cross-Cutting "Cross-context name collision avoidance" convention; same as `staff_user` from `epic-01`).
  - With the rename in place, this task's migration is simply:
    - `up`: `DROP TABLE IF EXISTS product;` (the inventory app's `product` table; the catalog tables are `catalog_product`/`catalog_variant`).
    - `down`: `CREATE TABLE product (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);` — to satisfy the down-migration contract. (The down body restores an empty table — historical data is gone; this is a forward-only operation in practice, and the down exists only for migration framework hygiene.)
- A code-level marker — a one-line comment in `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts` (and any sibling) at the location where `ProductEntity` is imported/joined:
  - `// TODO(epic-04): replaced by Variant reference; the inventory product table is dropped by epic-02 task-08.`
  - **Do not** remove the import or change the join — the inventory app would fail to compile if we yanked the entity. The TODO is the entire deliverable on the inventory side; `epic-04` does the actual rewiring.
- A `docs/implementation/04-…/01-…md` forward-reference is **not** authored here (that doc lives in `epic-04`'s task tree). This task is migration-only; no docs are written.

**Out:**

- Any change to inventory's `ProductEntity` (`apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts`). The file remains; its purpose becomes vestigial at runtime but the code still compiles.
- Any change to the inventory-microservice's `stock-typeorm.repository.ts` FK relation. The relation still exists in TypeORM's metadata; the underlying table is gone; the first runtime query that touches it errors. `epic-04` resolves this.
- Any data-migration work (copying inventory's `product.name` rows into the new catalog `catalog_product` table). The starter project's `product` table has no production data worth preserving; the test DB is reseeded by `scripts/test-db-seed.ts` (task-09 extends the seed to insert the two example Products in the new catalog tables).
- Any change to the catalog tables' schema (they were finalised in task-02).

## Decision: the rename rationale

Surfacing this in the decomposition rather than the per-task: **task-02's persistence shape should use `catalog_product` and `catalog_variant` as the actual MySQL table names, even though the domain model is called `Product`/`ProductVariant`**. The `@Entity('catalog_product')` decorator achieves this. The rationale:

- Avoids the collision with the inventory-microservice's existing `product` table during the migration window where both exist.
- Establishes a precedent for prefixing tables by their bounded context, matching the `staff_user` rename from `epic-01`.
- Documented in task-02's `03-product-and-variant-persistence.md` under a new "Why the `catalog_` table prefix" section.

If the operator opts not to make this rename, this task becomes more invasive: it must first rename the inventory `product` table out of the way before task-02's migration runs, then drop it later. The rename is the cleaner path. **The decomposition assumes the rename; if you disagree, surface the alternative before starting task-02.**

## Files to add

- `migrations/<ts>-DropInventoryProductTable.ts`.

## Files to modify

- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts` — add a one-line `TODO(epic-04)` comment at the line that imports or joins `ProductEntity`. Do not change behaviour.
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts` — add a top-of-file comment: `// Vestigial: the backing table was dropped by epic-02 task-08. Rewired to ProductVariant in epic-04.` Do not delete the file.

## Files to delete

None. The vestigial `product.entity.ts` is left in place until `epic-04`.

## Tests

- No new tests.
- The existing `yarn test:e2e` suite must continue to pass. **Caveat**: any e2e that exercises the inventory `product_stock` query path may now fail at runtime because the FK target is gone. If such tests exist, either:
  - `xit` them with a `TODO(epic-04)` marker, mirroring the catalog e2e's permission-failure `xit`s from task-06.
  - **Or** preserve them by leaving the join silently broken — the test fails fast on the first request, which is fine because `epic-04` is the next epic.
  - Take the first option. Locate them via `grep -rn 'GET.*product.*stock' test/`; mark with `xit` + `TODO(epic-04: rewire to variantId)`. The exact list depends on the current state of `test/`; verify before flipping anything.
- Migration round-trip verified manually: `yarn migration:run` applies cleanly on a fresh DB seeded up to task-07; `yarn migration:revert` re-creates the empty inventory `product` table.

## Doc deliverable

None. This task is migration-only; the doc deliverables for the epic are written by tasks 01–07 (and amended by task-09).

## Carryover produced (consumed by task-09 onward)

- The obsolete inventory `product` table is dropped from the schema.
- The inventory-microservice still compiles and boots; its runtime queries against the dropped table will fail until `epic-04` rewires them — captured as `TODO(epic-04)` comments in the relevant adapter files and as `xit` markers in the e2e suite.
- The catalog tables (`catalog_product`, `catalog_variant`) are the sole `product`-shaped tables in the schema.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn migration:run` applies cleanly on a fresh DB; `yarn migration:revert` undoes the change cleanly.
- [ ] `yarn build` succeeds for all five apps (the inventory app still compiles despite the vestigial entity).
- [ ] `yarn test:e2e` passes the catalog-e2e block from task-06; inventory-e2e blocks that exercise the old `product` table are `xit`-marked with `TODO(epic-04)`.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] The `TODO(epic-04)` markers exist in `stock-typeorm.repository.ts` and `product.entity.ts`.
