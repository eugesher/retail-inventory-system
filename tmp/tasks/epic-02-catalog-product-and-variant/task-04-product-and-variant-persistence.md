---
epic: epic-02
task_number: 4
title: Product and ProductVariant persistence
depends_on: [task-01, task-02, task-03]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/04-product-and-variant-persistence.md
adr_deliverable: none
---

# Task 04 — Product and ProductVariant persistence

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

Most relevant ADRs: **ADR-019** (TypeORM + MySQL; `BaseEntity`,
`SnakeNamingStrategy`, camelCase fields → snake_case columns, hand-authored
migrations, `synchronize` off; repositories extend `BaseTypeormRepository` and
are the only files using `InjectRepository`), **ADR-005** (extend `BaseEntity`
from `@retail-inventory-system/database`), **ADR-004 / ADR-017** (persistence
lives in `infrastructure/persistence/`; the application/domain layers stay
TypeORM-free), **ADR-025** (the aggregate this persists).

## Goal

Give the catalog domain durable storage: TypeORM entities, mappers (domain ↔
entity), a repository port and its TypeORM adapter, and the migration that
creates the `product` and `product_variant` tables in the shared `retail_db`
schema (now free of the inventory stub). Wire the entities into the catalog
module and register the connection at the app root.

## Entry state assumed

- task-01–03 carryover present. The catalog domain (`Product`, `ProductVariant`,
  status enums, three domain events) exists and is unit-tested. ADR-025 is
  committed.
- The `retail_db` schema has **no** `product` table (task-02 dropped the stub) —
  so `CREATE TABLE product` will not collide.
- `apps/catalog-microservice/src/app/app.module.ts` does **not** yet import
  `DatabaseModule.forRoot(...)` (task-01 left it out pending entities).
- `@retail-inventory-system/database` exports `BaseEntity`,
  `BaseTypeormRepository`, `DatabaseModule.forRoot/forFeature`,
  `SnakeNamingStrategy`.

## Scope

**In**

- Entities, mappers, repository port + TypeORM adapter, the create-tables
  migration, the repository spec, and the module/app wiring for persistence.

**Out**

- Use cases, events, controllers, the gateway (task-05+).
- Any cache (`CacheModule`) — catalog does not cache in this work; the cache-key
  builder reserved for the future is added in task-07.

## Entities (extend `BaseEntity`; let `SnakeNamingStrategy` map columns)

`BaseEntity` provides `id` (auto-increment int PK), `createdAt`, `updatedAt`,
and a nullable `deletedAt` (`@DeleteDateColumn`). **Catalog lifecycle is driven
by the `status` column; the inherited `deletedAt` soft-delete path is never
invoked** (no `softRemove`). The migration therefore includes a `deleted_at`
column (BaseEntity expects it on `find`) but it stays `NULL` forever — record
this decision in the doc (it is the literal reading of ADR-025's
soft-delete-via-`status` rule paired with ADR-019's extend-`BaseEntity` rule).

- `ProductEntity` (`@Entity('product')`): `name`, `slug`, `description`,
  `status` (enum column `draft|active|archived`), plus `BaseEntity` columns. A
  `@OneToMany` to `ProductVariantEntity` (cascade off — variants persist through
  the repository explicitly).
- `ProductVariantEntity` (`@Entity('product_variant')`): `productId`, `sku`,
  `gtin` (nullable), `optionValues` (`json` column), `weightG` (`int` nullable),
  `dimensionsMm` (`json` nullable), `status` (enum `active|archived`),
  `@ManyToOne` to `ProductEntity`. Column names map via the snake strategy
  (`weightG` → `weight_g`, `optionValues` → `option_values`, `dimensionsMm` →
  `dimensions_mm`, `productId` → `product_id`).

Follow the existing entity style under
`apps/inventory-microservice/src/modules/stock/infrastructure/persistence/` and
the gateway auth entities; do not add `@Column({ name })` overrides unless the
auto-mapping is genuinely wrong.

## Migration (use `yarn migration:create`)

`up()` — create both tables (snake_case columns; match `BaseEntity`):

```sql
CREATE TABLE product (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(255) NOT NULL,
  description TEXT NULL,
  status      ENUM('draft','active','archived') NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  TIMESTAMP NULL,
  CONSTRAINT UC_PRODUCT_SLUG UNIQUE (slug)
);

CREATE TABLE product_variant (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id    BIGINT UNSIGNED NOT NULL,
  sku           VARCHAR(255) NOT NULL,
  gtin          VARCHAR(64) NULL,
  option_values JSON NOT NULL,
  weight_g      INT NULL,
  dimensions_mm JSON NULL,
  status        ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    TIMESTAMP NULL,
  CONSTRAINT UC_PRODUCT_VARIANT_SKU UNIQUE (sku),
  CONSTRAINT UC_PRODUCT_VARIANT_GTIN UNIQUE (gtin),
  CONSTRAINT FK_PRODUCT_VARIANT_PRODUCT FOREIGN KEY (product_id)
    REFERENCES product (id) ON DELETE RESTRICT
);
```

`down()` — `DROP TABLE product_variant;` then `DROP TABLE product;` (child
first). Confirm the `id` column type matches the project convention
(`BIGINT UNSIGNED AUTO_INCREMENT`, as in `InitStarterEntities`).

**Index notes:** unique on `product.slug`, `product_variant.sku`, and
`product_variant.gtin`. MySQL allows multiple `NULL`s under a `UNIQUE`
constraint, so `UC_PRODUCT_VARIANT_GTIN` is effectively the "partial / nullable-aware"
unique the epic describes — no extra work on MySQL 8. The FK is `ON DELETE
RESTRICT` (a Product with variants cannot be hard-deleted; archival is the path).

## Repository port + adapter

- Port `application/ports/catalog.repository.port.ts`: `ICatalogRepositoryPort`
  + DI symbol `CATALOG_REPOSITORY`. Methods sized for the write use cases that
  land in task-05/06 and the reads in task-07 — at minimum:
  `save(product): Promise<Product>` (insert/update the root + its variants),
  `findById(id)`, `findBySlug(slug)`, `existsBySlug(slug)`, `existsBySku(sku)`,
  `findVariantById(variantId)`, and a paginated `listActive(pageRequest, search?)`.
  Keep it a pure TypeScript contract — **no** TypeORM types leak into the port
  (ADR-017 forbids `typeorm` in `application/ports`). Return domain types.
- Adapter `infrastructure/persistence/catalog-typeorm.repository.ts`:
  `CatalogTypeormRepository implements ICatalogRepositoryPort`, extends
  `BaseTypeormRepository` where it fits, uses `@InjectRepository`. The slug/sku
  uniqueness invariants are enforced here (unique constraint + an
  `existsBySlug`/`existsBySku` pre-check that returns a domain-friendly result so
  the use case can raise a clean duplicate error).
- Mappers `infrastructure/persistence/product.mapper.ts` and
  `product-variant.mapper.ts` (domain ↔ entity), mirroring
  `stock-item.mapper.ts` / the auth mappers.

## Module + app wiring

- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/index.ts`
  — barrel exporting `catalogEntities = [ProductEntity, ProductVariantEntity]`,
  the entities, the mappers, and the repository (mirror the inventory persistence
  barrel).
- `catalog.module.ts` — `DatabaseModule.forFeature(catalogEntities)`; provide
  `CatalogTypeormRepository` and bind `{ provide: CATALOG_REPOSITORY, useExisting: CatalogTypeormRepository }`
  (mirror `stock.module.ts`).
- `apps/catalog-microservice/src/app/app.module.ts` — add
  `DatabaseModule.forRoot(catalogEntities)` (re-export `catalogEntities` from
  `modules/catalog`), mirroring the inventory `AppModule`.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product.entity.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-variant.entity.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product.mapper.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-variant.mapper.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/catalog-typeorm.repository.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/index.ts`
- `apps/catalog-microservice/src/modules/catalog/application/ports/catalog.repository.port.ts`
- `apps/catalog-microservice/src/modules/catalog/application/ports/index.ts`
- One migration under `migrations/` (e.g. `<ts>-CreateCatalogTables.ts`).
- Repository spec (see Tests).

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`
- `apps/catalog-microservice/src/modules/catalog/index.ts` (export `catalogEntities`)
- `apps/catalog-microservice/src/app/app.module.ts`

## Files to delete

- None.

## Tests

- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/spec/catalog-typeorm.repository.spec.ts`
  — mapper round-trip (domain → entity → domain preserves `optionValues`,
  `dimensionsMm`, `status`); `existsBySlug`/`existsBySku` behaviour; modelled on
  `stock-typeorm.repository.spec.ts`.
- `yarn test:e2e` on a fresh `yarn test:infra:reload`: the new migration must
  apply cleanly **after** task-02's drop migration (no `product` collision) and
  revert cleanly.

## Doc deliverable

`docs/implementation/02-catalog-product-and-variant/04-product-and-variant-persistence.md`.
Outline: entity + mapper shapes; the repository port/adapter seam (why the port
returns domain types and stays TypeORM-free — ADR-017); the table DDL and index
choices; the `ON DELETE RESTRICT` rationale (archival, not deletion); the
nullable-`UNIQUE` GTIN behaviour on MySQL; and the inherited-but-inert
`deleted_at` decision. Cross-link ADR-019/025.

## Carryover to read

`carryover-01.md`, `carryover-02.md`, `carryover-03.md`.

## Carryover to produce

Write `carryover-04.md` capturing: the `product` + `product_variant` tables now
exist (column list + constraints + the new migration name/timestamp); the
`ICatalogRepositoryPort` method set + the `CATALOG_REPOSITORY` symbol;
`DatabaseModule.forRoot(catalogEntities)` is wired at the app root; the catalog
service now boots with a DB connection; verification commands.

## Exit criteria

- [ ] `product` and `product_variant` tables are created by the new migration
      with the unique indexes and the `ON DELETE RESTRICT` FK; it applies after
      task-02's drop with no collision and reverts cleanly.
- [ ] `ICatalogRepositoryPort` + `CATALOG_REPOSITORY` exist; the TypeORM adapter
      and mappers implement them; the port is free of TypeORM types.
- [ ] `DatabaseModule.forRoot(catalogEntities)` is registered; the catalog
      service boots with a live MySQL connection.
- [ ] `yarn lint` passes (`--max-warnings 0`) — application/ports and domain stay
      TypeORM-free; the repository adapter is the only `InjectRepository` site.
- [ ] `yarn test:unit` passes (repository/mapper spec green); `yarn test:e2e` passes.
- [ ] `docs/implementation/02-catalog-product-and-variant/04-product-and-variant-persistence.md` is written.
- [ ] The self-containment grep is clean:
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-04.md` is written.
