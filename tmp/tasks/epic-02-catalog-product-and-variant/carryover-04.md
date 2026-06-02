# Carryover 04 → task-05

Task-04 ("Product and ProductVariant persistence") is complete. This note is the
entry state for task-05 (register + add-variant use cases).

## Entry state for task-05

- The catalog context now has **durable storage**. The `product` and
  `product_variant` tables exist in `retail_db`, created by the new migration
  **`migrations/1780409695171-CreateCatalogTables.ts`** (class
  `CreateCatalogTables1780409695171`). It applies cleanly **after**
  `DropInventoryProductStub1780392162294` (no `product` collision) and reverts
  cleanly (drops `product_variant` then `product`).
- The catalog service **boots with a live MySQL connection**:
  `app.module.ts` now imports `DatabaseModule.forRoot(catalogEntities)`, and
  `catalog.module.ts` imports `DatabaseModule.forFeature([ProductEntity,
  ProductVariantEntity])` and binds `CATALOG_REPOSITORY` →
  `CatalogTypeormRepository`. (Boot log: `SELECT version()` probe → `Catalog
  Microservice is listening for messages`.)
- `catalog.module.ts` is **no longer empty** — it provides the repository. There
  is still **no** `application/use-cases`, **no** `presentation/`, **no**
  message handler, and **no** `CacheModule`.
- All gates green on a fresh run: `yarn lint` (exit 0, `--max-warnings 0`),
  `yarn test:unit` (**343 passed**, 48 suites — was 335, +8 catalog
  repository/mapper specs), `yarn build` (5 apps), `yarn test:e2e`
  (5 suites / 55 tests / 38 snapshots), self-containment grep clean.

### `product` table (snake_case columns)

```
id BIGINT UNSIGNED AI PK | name VARCHAR(255) | slug VARCHAR(255) |
description TEXT NULL | status ENUM('draft','active','archived') DEFAULT 'draft' |
created_at | updated_at | deleted_at (inert — always NULL)
UNIQUE: UC_PRODUCT_SLUG (slug)
```

### `product_variant` table

```
id BIGINT UNSIGNED AI PK | product_id BIGINT UNSIGNED NOT NULL | sku VARCHAR(255) |
gtin VARCHAR(64) NULL | option_values JSON NOT NULL | weight_g INT NULL |
dimensions_mm JSON NULL | status ENUM('active','archived') DEFAULT 'active' |
created_at | updated_at | deleted_at (inert)
UNIQUE: UC_PRODUCT_VARIANT_SKU (sku), UC_PRODUCT_VARIANT_GTIN (gtin)
FK: FK_PRODUCT_VARIANT_PRODUCT (product_id → product.id) ON DELETE RESTRICT
```

## Files added

- `apps/catalog-microservice/src/modules/catalog/application/ports/catalog.repository.port.ts`
- `apps/catalog-microservice/src/modules/catalog/application/ports/index.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product.entity.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-variant.entity.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product.mapper.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-variant.mapper.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/catalog-typeorm.repository.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/index.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/spec/catalog-typeorm.repository.spec.ts`
- `migrations/1780409695171-CreateCatalogTables.ts`
- `docs/implementation/02-catalog-product-and-variant/04-product-and-variant-persistence.md`

## Files modified

- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts` — wires
  `DatabaseModule.forFeature(...)` + the repository providers.
- `apps/catalog-microservice/src/modules/catalog/index.ts` — now
  `export { catalogEntities } from './infrastructure/persistence';` **then**
  `export * from './catalog.module';`.
- `apps/catalog-microservice/src/app/app.module.ts` — adds
  `DatabaseModule.forRoot(catalogEntities)`.
- `CLAUDE.md` — architecture intro, app-tree line, Service Structure paragraph
  (catalog no longer "empty"; persistence wired), Database section (catalog
  entity location).
- `README.md` — Shared DB schema box gained a `product / product_variant` row.

## Files deleted

- None.

## Key decisions & deviations (task-05 must respect)

- **`ICatalogRepositoryPort` + `CATALOG_REPOSITORY` symbol** (in
  `application/ports/catalog.repository.port.ts`). Method set:
  `save(product): Promise<Product>` (insert/update root + variants in one tx),
  `findById`, `findBySlug`, `existsBySlug`, `existsBySku`,
  `findVariantById`, `listActive(query): Promise<IProductPage>`. **Returns
  domain types only — no TypeORM types** (ADR-017 keeps `typeorm` out of
  `application/ports`).
- **Pagination types are declared LOCALLY in the port** (`ICatalogListActiveQuery`,
  `IProductPage`), not imported from `libs/common`. Reason: the boundaries lint
  allows `application-port` to import only `lib-ddd` + `lib-contracts` (+ own
  `domain/`), **not `lib-common`**. Don't try to import `IPage`/`IPageRequest`
  from `@retail-inventory-system/common` into a port — it will fail `yarn lint`.
- **`existsBySlug` / `existsBySku` are the uniqueness pre-check seam for
  task-05.** The domain cannot enforce global slug/sku uniqueness (ADR-025 §4);
  the migration's UNIQUE constraints are the hard guard. **task-05's register /
  add-variant use-case specs must assert the duplicate rejection via a
  repository test double** (carryover-03 flagged this; the port now provides the
  methods to stub).
- **`save` re-reads the saved graph** (`findById` after commit) so the returned
  aggregate carries concrete variant ids + timestamps. This is how task-05
  satisfies ADR-025's "re-read the concrete `variantId` from the saved aggregate
  before emitting the `VariantCreatedEvent` wire event" requirement —
  `repository.save(product)` already returns variants with non-null ids.
- **`forFeature` takes the entity-classes literal**, not `catalogEntities`.
  `catalogEntities` (typed `TypeOrmModuleOptions['entities']`, includes
  `undefined`) satisfies `forRoot` but **not** `forFeature`'s
  `EntityClassOrSchema[]` — same split `stock.module.ts` lives with.
- **`deleted_at` is inherited from `BaseEntity` but inert** — catalog never
  soft-removes; `status` is the lifecycle. The migration creates the column
  (TypeORM appends `deleted_at IS NULL` to every `find`) but it stays NULL.
- **Entities extend `BaseEntity`**; `@PrimaryGeneratedColumn()` metadata is `int`
  while the DDL is `BIGINT UNSIGNED` — the project's standing split (`order`
  tables are the same). `synchronize` is off, so the DDL wins.
- **JSON columns** (`option_values`, `dimensions_mm`) are the first in the
  schema. The domain getters expose raw shapes; the VOs stay domain-internal.
- **No catalog seed** was added (task-10 owns seeding). The tables are empty.

## Known gaps (owned by later tasks)

- **Register + add-variant use cases** (assert slug/sku uniqueness via the
  `existsBy*` repo doubles; drain `VariantCreatedEvent` and map to the versioned
  `v1` wire event after `save`) — **task-05**.
- **Publish + archive use cases** (the active-Price warn-not-block lives in the
  publish use case) — **task-06**.
- **Query read path** (`listActive` exists on the port + adapter; the top-level
  variant read model / `findVariantById` exposure is fleshed out) — **task-07**.
- **API gateway catalog module** (map `CatalogErrorCodeEnum` → HTTP status) —
  **task-08**.
- **Kulala `http/catalog.http`** — **task-09**.
- **Seed + docs finalization** — **task-10** still owns: the catalog seed, the
  CLAUDE.md ADR "next free number" bump (now stale at "025" — ADR-025 is
  committed, so it should read "026") and any consolidated catalog domain
  section, plus README polish. task-04 only updated the CLAUDE.md/README
  statements its own change made false (persistence wiring + schema box).
- **`product_id` → `variantId` reshape** in inventory/retail + retail
  order-create validation against a published variant — later cross-context
  work, **not** tasks 04–10 (from carryover-02/03).

## How to verify

```bash
yarn lint                 # --max-warnings 0, exit 0
yarn test:unit            # 343 passed, 48 suites (catalog repo/mapper specs green)
yarn build                # 5 apps compile

# Schema + e2e (fresh infra reload → migrate → seed → tests):
yarn test:e2e             # 5 suites / 55 tests / 38 snapshots
#   log shows "Migration CreateCatalogTables1780409695171 has been executed successfully"
#   AFTER the DropInventoryProductStub migration — no `product` collision.

# Migration reversibility (against the running, seeded DB — catalog tables are
# unseeded and unreferenced, so revert is clean either way):
yarn migration:revert     # drops product_variant then product
yarn migration:show       # [ ] CreateCatalogTables1780409695171
yarn migration:run        # re-applies cleanly

# Boot with a live DB connection:
OTEL_SDK_DISABLED=true node dist/apps/catalog-microservice/main.js
#   → "query: SELECT version()" then "Catalog Microservice is listening for messages"

# Self-containment gate (expected: no orchestration references):
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```

Note: infra (rabbitmq/mysql/redis) was left **up and seeded** after the e2e +
migration round-trip; tear it down with `yarn test:infra:down` for a clean slate.
