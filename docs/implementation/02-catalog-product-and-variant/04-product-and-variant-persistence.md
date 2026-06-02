# 04 — `Product` and `ProductVariant` persistence

This document records how the catalog write-side domain gains **durable
storage**: the TypeORM entities, the domain ↔ entity mappers, the repository
port and its TypeORM adapter, the migration that creates the `product` and
`product_variant` tables, and the module/app wiring that registers the MySQL
connection.

The domain it persists is described in
[03 — The `Product` and `ProductVariant` domain](./03-product-and-variant-domain.md);
the `product` table name was freed by
[02 — Removing the inventory `product` stub](./02-inventory-product-stub-removed.md);
the service was scaffolded empty in
[01 — The catalog microservice scaffold](./01-new-catalog-microservice-scaffold.md).
The persistence stack and its rules are
[ADR-019 (TypeORM + MySQL)](../../adr/019-typeorm-and-mysql-for-persistence.md);
the aggregate shape and its lifecycle rules are
[ADR-025 (the catalog `Product` aggregate)](../../adr/025-catalog-product-and-variant-aggregate.md).
The code lives under
`apps/catalog-microservice/src/modules/catalog/{application/ports,infrastructure/persistence}/`.

## 1. Entities — extend `BaseEntity`, let the snake strategy map columns

Both entities extend `BaseEntity` from `@retail-inventory-system/database`,
which supplies `id` (`@PrimaryGeneratedColumn()`), `createdAt`, `updatedAt`, and
a nullable `deletedAt` (`@DeleteDateColumn`). Fields are declared in camelCase
and `SnakeNamingStrategy` maps them to snake_case columns, so there are no
`@Column({ name })` overrides (ADR-019).

`ProductEntity` (`@Entity('product')`):

- `name`, `slug` — `varchar(255)`.
- `description` — `text`, nullable.
- `status` — an `enum` column (`draft | active | archived`), defaulting to
  `draft`, typed by the domain `ProductStatusEnum`. The enum lives in the
  catalog `domain/` (it is an internal domain concept, not a wire contract —
  ADR-025 §7), and the infrastructure layer is allowed to import its own
  module's domain.
- `variants` — a `@OneToMany` to `ProductVariantEntity` **with cascade off**.
  Variants persist through the repository explicitly (see §3); the relation
  exists for graph reads, not for cascading writes or deletes.

`ProductVariantEntity` (`@Entity('product_variant')`):

- `productId` — an explicit scalar column alongside the `@ManyToOne` relation
  (`@JoinColumn({ name: 'product_id' })`); both target `product_id`. This is the
  same twin-mapping the retail `order_product` entity uses for `orderId`/`order`
  — the scalar is what the repository writes, the relation is for reads.
- `sku` — `varchar(255)`; `gtin` — `varchar(64)`, nullable.
- `optionValues` — a `json` column (`option_values`); `dimensionsMm` — a `json`
  column (`dimensions_mm`), nullable. These are the **first JSON columns in the
  schema**. The domain getters already expose the raw shapes
  (`Record<string,string>` and `{ l, w, h } | null`), so the value objects that
  guard the invariants never cross the persistence boundary.
- `weightG` — `int` (`weight_g`), nullable.
- `status` — an `enum` column (`active | archived`), defaulting to `active`,
  typed by `ProductVariantStatusEnum`.

### The inherited-but-inert `deleted_at`

`BaseEntity` declares a `@DeleteDateColumn`, and TypeORM transparently appends
`deleted_at IS NULL` to every `find`/`findOne`. **Catalog never soft-removes** —
the lifecycle is driven entirely by the `status` column (ADR-025 §2: an archived
product or variant must stay resolvable forever, because historical orders and
stock rows reference variants by id). The migration therefore creates a
`deleted_at` column (so the `find`-time predicate has a column to read) but it
stays `NULL` for every row, for all time. This is the literal reading of
ADR-025's "soft-delete via `status`" paired with ADR-019's "extend `BaseEntity`":
we keep the inherited column rather than fighting the base class, and we simply
never write it. Anyone reading the schema should treat `status` — not
`deleted_at` — as the lifecycle source of truth.

## 2. Mappers — domain ↔ entity, value objects stay internal

`ProductMapper` and `ProductVariantMapper` are plain static classes mirroring
`stock-item.mapper.ts` and the order mappers.

- `ProductVariantMapper.toEntity(variant, productId)` takes the parent id
  explicitly, because a freshly added variant still carries a `null` `productId`
  on the aggregate until the parent row is saved. It **omits a `null` id** so
  TypeORM treats the row as an insert, and passes a concrete id for an update.
- `ProductMapper.toEntity(product)` maps the root only (cascade is off); the
  repository writes the row first to obtain the id, then maps the children.
- `toDomain` rebuilds via `Product.reconstitute(...)` / `new ProductVariant(...)`.
  A `null` `description` column maps to `undefined` so the aggregate applies its
  empty-string default.

## 3. Repository port + adapter — the TypeORM-free seam

The port `application/ports/catalog.repository.port.ts` declares
`ICatalogRepositoryPort` and the DI symbol `CATALOG_REPOSITORY`. Its surface is
sized for the write paths and the read path that build on it:

```
save(product): Promise<Product>          // insert/update the root + its variants
findById(id): Promise<Product | null>
findBySlug(slug): Promise<Product | null>
existsBySlug(slug): Promise<boolean>
existsBySku(sku): Promise<boolean>
findVariantById(variantId): Promise<ProductVariant | null>
listActive(query): Promise<IProductPage>  // paginated active catalogue
```

**The port returns domain types and stays TypeORM-free.** No `Repository`,
`EntityManager`, or entity type appears in it — ADR-017's boundaries lint
forbids `typeorm` in `application/ports`, and the architectural intent is that
the application layer never depends on the ORM. The TypeORM details live
entirely in the adapter. One consequence worth recording: the
`application-port` layer is allowed to import only `lib-ddd` and `lib-contracts`
(plus its own module's `domain/`), **not** `lib-common`. So the pagination
query/result shapes (`ICatalogListActiveQuery`, `IProductPage`) are declared
**locally in the port file** rather than reusing `libs/common`'s `IPage` /
`IPageRequest` — the same local-interface pattern the stock repository port uses
for its payload types.

The adapter `infrastructure/persistence/catalog-typeorm.repository.ts`
(`CatalogTypeormRepository`) implements the port, extends
`BaseTypeormRepository<ProductEntity, Product>` for the `toDomain`/`toEntity`
seam, and is the **only `@InjectRepository` site** in the context (it injects
both the product and variant repositories).

`save` is overridden because the root and its variants persist explicitly
(cascade off) and must commit atomically: it opens one transaction
(`repository.manager.transaction`), saves the `product` row to obtain the id,
maps and saves each variant against that id, then re-reads the full graph so the
returned aggregate carries the concrete variant ids and DB-assigned timestamps.
A half-written graph (a product missing some variants) would later violate the
publish invariant, so atomicity is load-bearing.

### slug / sku uniqueness lives at the repository

The domain cannot see other aggregates, so it cannot enforce that `slug` and
`sku` are globally unique (ADR-025 §4). That invariant is the repository's: the
UNIQUE constraints in the schema are the hard guard, and `existsBySlug` /
`existsBySku` give the write use cases (later work) a clean pre-check so a
duplicate raises a typed domain error instead of surfacing a raw driver
exception. A race that slips past the pre-check still hits the UNIQUE constraint
and fails the transaction — correctness does not depend on the pre-check, only
the quality of the error message does.

## 4. Migration — the table DDL and index choices

The migration `migrations/1780409695171-CreateCatalogTables.ts` creates both
tables in `up()` and drops them child-first in `down()`. `id` is
`BIGINT UNSIGNED AUTO_INCREMENT` to match the project convention (the entities'
`@PrimaryGeneratedColumn()` only carries `int` in TypeORM metadata; with
`synchronize` off the wider DB type is the source of truth — the retail `order`
tables already live with this same metadata/DDL split).

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

**Indexes.** Unique on `product.slug`, `product_variant.sku`, and
`product_variant.gtin` — the three identifiers the catalogue and downstream
contexts look products and variants up by.

### Nullable-`UNIQUE` GTIN on MySQL

Not every variant has a GTIN (a barcode), so `gtin` is nullable — but when
present it must be globally unique. On MySQL a `UNIQUE` index permits **multiple
`NULL` values** while still rejecting duplicate non-null values, so
`UC_PRODUCT_VARIANT_GTIN` is effectively the "nullable-aware / partial" unique
the catalogue wants, with no extra machinery on MySQL 8. (A database that
treated `NULL` as a normal value under `UNIQUE` would need a filtered/partial
index instead; MySQL does not.)

### `ON DELETE RESTRICT` — archival, not deletion

The FK from `product_variant.product_id` to `product.id` is `ON DELETE
RESTRICT`: a product that has variants **cannot be hard-deleted**. This is the
schema-level expression of ADR-025's lifecycle rule — products and variants are
retired by moving `status` to `archived`, never by removing the row, because
historical orders and stock reference variants by id and those ids must keep
resolving. `RESTRICT` makes the wrong operation (a destructive delete) fail
loudly rather than silently cascade away rows that other contexts still point
at.

`down()` drops `product_variant` before `product` (the FK forbids the reverse
order). Because [02](./02-inventory-product-stub-removed.md) already dropped the
old inventory `product` table and both FKs that pointed at it, this migration's
`product` table is free-standing — nothing references it — so both the forward
and reverse directions run cleanly on a seeded or unseeded schema.

## 5. Module + app wiring

- `infrastructure/persistence/index.ts` is the barrel: it exports
  `catalogEntities = [ProductEntity, ProductVariantEntity]`, the entities, the
  mappers, and the repository (mirroring the inventory persistence barrel).
- `modules/catalog/catalog.module.ts` imports
  `DatabaseModule.forFeature([ProductEntity, ProductVariantEntity])`, provides
  `CatalogTypeormRepository`, and binds `{ provide: CATALOG_REPOSITORY,
  useExisting: CatalogTypeormRepository }` (mirroring `stock.module.ts`). The
  `forFeature` argument is the entity-classes literal rather than the
  `catalogEntities` const, whose looser `TypeOrmModuleOptions['entities']` type
  does not satisfy `forFeature`'s `EntityClassOrSchema[]` parameter —
  `forRoot` accepts the loose type, `forFeature` does not.
- `app/app.module.ts` adds `DatabaseModule.forRoot(catalogEntities)`, so the
  service now boots with a live MySQL connection (mirroring the inventory
  `AppModule`).

## 6. Verification

- `yarn lint` (`--max-warnings 0`) is clean: the port and domain stay
  TypeORM-free, and `CatalogTypeormRepository` is the only `InjectRepository`
  site.
- `yarn test:unit` covers the mapper round-trip (domain → entity → domain
  preserves `optionValues`, `dimensionsMm`, and `status`) and the
  `existsBySlug` / `existsBySku` / `findById` behaviour, modelled on the stock
  repository spec.
- `yarn test:e2e` on a fresh `yarn test:infra:reload` applies the new migration
  cleanly **after** the stub-drop migration (no `product` collision) and seeds;
  `yarn migration:revert` then `yarn migration:run` round-trips the migration.
- Booting the built service logs the TypeORM `SELECT version()` probe followed
  by `Catalog Microservice is listening for messages`, confirming the live DB
  connection.

## What this does not do

No use cases, events, controllers, gateway routes, or cache — those build on
this seam in later catalog work. There is no catalog seed yet; the tables are
created empty. The `product_id` columns elsewhere in the schema
(`product_stock`, `order_product`) are **not** reshaped onto a catalog
`variantId` here — that cross-context reshape is owned by later inventory/retail
work, as recorded in
[02 — Removing the inventory `product` stub](./02-inventory-product-stub-removed.md).
