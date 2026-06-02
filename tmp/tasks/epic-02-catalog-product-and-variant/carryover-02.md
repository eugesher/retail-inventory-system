# Carryover 02 → task-03

Task-02 ("Remove the inventory `product` stub") is complete. This note is the
entry state for task-03 (the catalog `Product` / `ProductVariant` domain).

## Entry state for task-03

- The `retail_db` schema has **no** `product` table and **no** `Product` entity
  anywhere in the codebase. The drop shipped as the forward migration
  **`migrations/1780392162294-DropInventoryProductStub.ts`** (class
  `DropInventoryProductStub1780392162294`).
- **Both** foreign keys onto `product (id)` are gone:
  `FK_PRODUCT_STOCK_PRODUCT` (inventory `product_stock.product_id`) and
  `FK_ORDER_PRODUCT_PRODUCT` (retail `order_product.product_id`).
- `product_stock.product_id` and `order_product.product_id` survive as plain
  `BIGINT UNSIGNED` integers with **no FK**. The seeds still load their integer
  `product_id` values via `INSERT IGNORE`.
- The catalog `product` / `product_variant` tables still do **not** exist —
  task-04 creates them. task-03 writes no SQL (domain only). The `product`
  table name is now free for catalog to claim.
- All four pre-existing services are green: `yarn lint` (max-warnings 0),
  `yarn test:unit` (313 passed), `yarn build`, and `yarn test:e2e`
  (5 suites / 55 tests / 38 snapshots) all pass on a fresh
  `yarn test:infra:reload`.

## Files added

- `migrations/1780392162294-DropInventoryProductStub.ts` — drops both FKs then
  `product` in `up()`; recreates the table + both FKs in `down()`.
- `docs/implementation/02-catalog-product-and-variant/02-inventory-product-stub-removed.md`.

## Files modified

- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/index.ts`
  — removed the `Product` import, its `stockEntities` array entry, and its
  barrel re-export.
- `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts`
  — removed `Product` from the import block and from `DatabaseModule.forFeature([...])`.
- `scripts/utils/test-db-seed.util.ts` — removed `'product.sql'` from
  `TestDbSeedUtil.seedFiles` (kept `product-stock.sql`, `order.sql`,
  `order-product.sql`).
- **Retail (collateral — see Key decisions):**
  - `.../orders/application/ports/order.repository.port.ts` — removed
    `findExistingProductIds` from `IOrderRepositoryPort`.
  - `.../orders/infrastructure/persistence/order-typeorm.repository.ts` — removed
    the `findExistingProductIds` impl (the only `SELECT id FROM product` reader)
    and its now-unused `@InjectDataSource() dataSource` field + `DataSource` /
    `InjectDataSource` imports.
  - `.../orders/presentation/orders.controller.ts` — `@Payload(OrderCreatePipe)`
    → `@Payload()` on the create handler; dropped the `OrderCreatePipe` import.
  - `.../orders/infrastructure/orders.module.ts` — removed `OrderCreatePipe`
    from providers + import.
  - `.../orders/presentation/pipes/index.ts` — removed the `order-create.pipe`
    re-export.
  - `.../orders/application/use-cases/spec/test-doubles.ts` — removed the
    `findExistingProductIds` test-double stub.
  - `test/system-api.e2e-spec.ts` (+ `__snapshots__/system-api.e2e-spec.ts.snap`)
    — removed the `returns 400 when productId does not exist` case and its
    snapshot.
- `README.md` — schema box (dropped the standalone `product` table line),
  retail `pipes/` comment (now `OrderConfirmPipe` only).
- `CLAUDE.md` — inventory persistence entity list (dropped `Product`), retail
  `pipes/` comment (now `OrderConfirmPipe` only).

## Files deleted

- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts`
- `scripts/seeds/product.sql`
- `apps/retail-microservice/src/modules/orders/presentation/pipes/order-create.pipe.ts`

## Key decisions & deviations

- **Both FKs dropped, including the retail one.** The epic prose named only
  `product_stock.product_id`, but the shared schema had two FKs onto
  `product (id)`. `DROP TABLE product` fails while either exists, so both were
  dropped; `order_product.product_id` is kept as a plain integer, exactly like
  `product_stock.product_id`.
- **The `product.sql` seed was deleted** and de-registered from `seedFiles`;
  `product-stock.sql` / `order-product.sql` retain their integer `product_id`
  values.
- **The historical `1772600000000-InitStarterEntities` migration is left
  immutable** — the drop is a new forward migration, not an edit to history
  (ADR-019).
- **DEVIATION (not in the task's written scope, confirmed with the user):**
  removing the `product` table also broke the retail order-create
  product-existence check, which read `SELECT id FROM product` via
  `OrderTypeormRepository.findExistingProductIds` (called from `OrderCreatePipe`).
  Three order-create e2e cases failed on a fresh reload. Per the
  conflict-resolution rule ("delete every reference to the removed thing in the
  same task"), the check was **removed cleanly** rather than re-pointed at a
  table that does not exist yet. `POST /api/order` now accepts any
  positive-integer `productId`. This was an explicit user decision among
  {remove cleanly / neutralize as a no-op / stop-and-replan} → **remove
  cleanly**.

## Known gaps (owned by later work)

- **`product_id` is not yet `variantId`.** The inventory and retail models still
  key on a plain-integer `product_id`. Reshaping these columns onto a catalog
  `variantId` is owned by a **later inventory change**, not this cleanup and not
  the catalog tasks 03–10.
- **Order creation no longer validates product existence.** Restoring this — by
  validating the ordered identifier against the catalog (a published variant) —
  is owned by the work that wires the **retail order flow to the catalog read
  path**. No task in this epic (03–10) re-points it; the epic builds the catalog
  service + gateway module but does not touch the retail order-create flow. Flag
  for a follow-up if retail-side validation is required before that wiring lands.
- The catalog `product` / `product_variant` tables and entities arrive in
  **task-04**; the domain (no SQL) is **task-03**.

## How to verify

```bash
# Static
yarn lint                 # --max-warnings 0, clean
yarn test:unit            # 313 passed

# Schema: fresh slate proves the drop applies with no FK error + seed loads
yarn test:infra:reload    # down -v → up → migration:run → test:seed
yarn test:e2e:run         # 5 suites / 55 tests / 38 snapshots, all green

# Reversibility (run on an UNSEEDED schema — see the doc's §5 for why):
yarn test:infra:down && yarn test:infra:up
yarn migration:run        # DropInventoryProductStub applies (drops both FKs + table)
yarn migration:revert     # recreates product + re-adds both FKs
yarn migration:run        # re-drops cleanly
#   (reverting against a seeded DB intentionally fails — orphan product_id rows)

# Self-containment gate (expected: no orchestration references)
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```

Note: infra was left **up and seeded** after this task. Tear it down with
`yarn test:infra:down` for a clean slate.
