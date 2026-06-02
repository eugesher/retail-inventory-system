---
epic: epic-02
task_number: 2
title: Remove the inventory product stub (conflict-resolution cleanup)
depends_on: [task-01]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/02-inventory-product-stub-removed.md
adr_deliverable: none
---

# Task 02 — Remove the inventory product stub (conflict-resolution cleanup)

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

Most relevant ADRs: **ADR-019** (TypeORM + MySQL; hand-authored migrations,
`synchronize` stays off), **ADR-012** (the inventory `stock` module and its
`product_stock` ledger).

## Goal

Delete the inventory microservice's vestigial `product` stub **outright** so the
catalog microservice can own the `product` table name in the single shared
`retail_db` schema. This is the conflict-resolution cleanup: a removal, never a
rename. After this task the schema has **no** `product` table and **no**
`Product` entity anywhere; the inventory `product_stock.product_id` and the
retail `order_product.product_id` columns survive as **plain integers with no
foreign key**, ready to be reshaped onto `variantId` by a later inventory change.

## Entry state assumed

- task-01 carryover present: the catalog app boots empty; `CATALOG_QUEUE` and
  `AppNameEnum.CATALOG_MICROSERVICE` exist. No catalog tables exist yet.
- The inventory `product` stub is **still present**:
  - Table `product` (columns `id`, `name`, `created_at`, `updated_at`) created
    by `migrations/1772600000000-InitStarterEntities.ts`.
  - Entity `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts`
    (`@Entity('product')` — class `Product`, columns `id`/`name`/`createdAt`/`updatedAt`).
  - Two foreign keys reference `product (id)` (both declared in
    `1772600000000-InitStarterEntities.ts`):
    - `FK_PRODUCT_STOCK_PRODUCT` on `product_stock.product_id`.
    - `FK_ORDER_PRODUCT_PRODUCT` on `order_product.product_id`.
  - Seed `scripts/seeds/product.sql` inserts four `product` rows; it is the
    first entry in `scripts/utils/test-db-seed.util.ts` → `TestDbSeedUtil.seedFiles`.

## Scope

**In**

- A new forward migration dropping **both** FKs, then the `product` table.
- Deleting `product.entity.ts` and every reference to the `Product` class.
- Deleting the `product.sql` seed and its `seedFiles` registration.

**Out**

- Touching the catalog tables (they don't exist yet — task-04 creates them).
- Reshaping `product_id` onto `variantId` — explicitly deferred to a later
  inventory change. Leave both `product_id` columns as plain integers.
- Editing the historical `1772600000000-InitStarterEntities.ts` migration — it
  is immutable history; the new drop migration is the mechanism (ADR-019).

## Why both foreign keys (do not miss the retail one)

The epic prose names only `product_stock.product_id`, but the shared schema has
**two** FKs onto `product (id)`. `DROP TABLE product` fails while either FK
exists. The start-from-scratch latitude lets you drop the now-dangling retail FK
too: drop `FK_ORDER_PRODUCT_PRODUCT` and keep `order_product.product_id` as a
plain integer, exactly as you keep `product_stock.product_id`. Nothing is left
dangling against a dropped table.

## The migration (use `yarn migration:create`)

`up()` — order matters (drop FKs before the table):

```sql
ALTER TABLE product_stock DROP FOREIGN KEY FK_PRODUCT_STOCK_PRODUCT;
ALTER TABLE order_product DROP FOREIGN KEY FK_ORDER_PRODUCT_PRODUCT;
DROP TABLE product;
```

`down()` — reverse, recreating the stub exactly as `InitStarterEntities` had it,
then re-adding both FKs (so the migration is cleanly reversible):

```sql
CREATE TABLE product (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
ALTER TABLE product_stock ADD CONSTRAINT FK_PRODUCT_STOCK_PRODUCT
  FOREIGN KEY (product_id) REFERENCES product (id);
ALTER TABLE order_product ADD CONSTRAINT FK_ORDER_PRODUCT_PRODUCT
  FOREIGN KEY (product_id) REFERENCES product (id);
```

Confirm the exact FK names against `migrations/1772600000000-InitStarterEntities.ts`
before writing the migration.

## Code references to remove / fix

- **Delete** `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts`.
- **Edit** `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/index.ts`:
  remove `import { Product } from './product.entity';`, remove `Product` from the
  `stockEntities` array, and remove `Product` from the
  `export { Product, ProductStock, ProductStockAction, Storage };` line.
- **Edit** `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts`:
  remove `Product` from the import block and from
  `DatabaseModule.forFeature([Product, ProductStock, ProductStockAction, Storage])`.
- Grep the inventory app for any other `Product` (the class) usage and remove it.
  Note: `aggregateForProduct`, `lockedTotalsByProduct`, `productId`, and the
  `ProductStock*` entities are **not** the stub — leave them untouched.

## Seed references to remove / fix

- **Delete** `scripts/seeds/product.sql`.
- **Edit** `scripts/utils/test-db-seed.util.ts`: remove `'product.sql'` from
  `TestDbSeedUtil.seedFiles` (keep `product-stock.sql`, `order.sql`,
  `order-product.sql`).
- `product-stock.sql` and `order-product.sql` keep their integer `product_id`
  values — with the FKs dropped these are plain integers and the `INSERT IGNORE`
  rows still load. Do **not** delete those seeds.

## Files to add

- One migration under `migrations/` (timestamped by `yarn migration:create`),
  e.g. `migrations/<ts>-DropInventoryProductStub.ts`.

## Files to modify

- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/index.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts`
- `scripts/utils/test-db-seed.util.ts`

## Files to delete

- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts`
- `scripts/seeds/product.sql`

## Tests

- No new unit specs. The inventory stock specs
  (`stock-typeorm.repository.spec.ts`, the use-case specs) must stay green — they
  never depend on the `Product` class, only on `product_id` integers.
- `yarn test:e2e` must pass on a fresh `yarn test:infra:reload`: confirm
  `migration:run` applies the new drop migration with no FK error, and the seed
  loads without `product.sql`.
- Verify reversibility: `yarn migration:run` then `yarn migration:revert` then
  `yarn migration:run` again applies cleanly.

## Doc deliverable

`docs/implementation/02-catalog-product-and-variant/02-inventory-product-stub-removed.md`.
Outline:

1. **Why the stub is removed up front** — single shared `retail_db` schema; the
   catalog `product` table cannot be created while the inventory stub owns the
   name. Removal (not rename) per the project's conflict-resolution rule.
2. **What was dropped** — the `product` table, the `Product` entity, the barrel
   re-export, the `forFeature` registration, and **both** foreign keys
   (`FK_PRODUCT_STOCK_PRODUCT`, `FK_ORDER_PRODUCT_PRODUCT`).
3. **Why `product_id` stays a plain integer** — on both `product_stock` and
   `order_product`; a later inventory change reshapes these onto `variantId`;
   nothing is left dangling.
4. **Migration mechanics** — forward drop, reversible `down()`, `synchronize`
   stays off (ADR-019). Reference `02`'s sibling docs and ADR-012/019 by
   relative path. Describe forward work by capability, never by an epic/task id.

## Carryover to produce

Write `tmp/tasks/epic-02-catalog-product-and-variant/carryover-02.md` capturing:

- **Entry state for task-03** — the `retail_db` schema has **no** `product`
  table and no `Product` entity; `product_stock.product_id` and
  `order_product.product_id` are plain integers (no FK); the migration name +
  timestamp; the catalog `product`/`product_variant` tables still do **not**
  exist (task-04 creates them).
- **Files added / modified / deleted** — the lists above, including the migration name.
- **Key decisions** — both FKs dropped (including the retail one the epic prose
  omitted); `product.sql` seed removed; historical InitStarterEntities migration
  left immutable.
- **Known gaps** — the inventory model still keys on `product_id` (not yet
  `variantId`); that reshape is owned by a later inventory change, not this work.
- **How to verify** — `yarn test:infra:reload` (down → up → migrate → seed),
  then `yarn migration:revert && yarn migration:run`; `yarn lint`; `yarn test:unit`.

## Carryover to read

`carryover-01.md`.

## Exit criteria

- [ ] The `product` table, `product.entity.ts`, its barrel re-export, its
      `forFeature` registration, and **both** FKs onto `product (id)` are gone.
- [ ] `product_stock.product_id` and `order_product.product_id` remain as plain
      integer columns (no FK).
- [ ] `scripts/seeds/product.sql` is deleted and removed from `seedFiles`.
- [ ] The new migration applies and reverts cleanly (`migration:run` →
      `migration:revert` → `migration:run`), `synchronize` stays off.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `yarn test:e2e` passes on a fresh
      `yarn test:infra:reload`.
- [ ] `docs/implementation/02-catalog-product-and-variant/02-inventory-product-stub-removed.md` is written.
- [ ] The self-containment grep is clean:
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-02.md` is written.
