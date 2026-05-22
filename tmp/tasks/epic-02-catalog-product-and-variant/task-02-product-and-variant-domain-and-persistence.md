---
epic: epic-02
task_number: 2
title: Add Product + ProductVariant domain, persistence, repository port/adapter, and the creation migration
depends_on: [task-01]
doc_deliverable_primary: docs/implementation/epic-02-catalog-product-and-variant/02-product-and-variant-domain.md
doc_deliverable_secondary: docs/implementation/epic-02-catalog-product-and-variant/03-product-and-variant-persistence.md
---

# Task 02 — `Product` + `ProductVariant` domain + persistence + repository port/adapter

## Goal

Fill the empty `apps/catalog-microservice/src/modules/catalog/` tree with the catalog write-side data model. Add the `Product` aggregate (root) and the `ProductVariant` child entity, their value objects, the matching TypeORM entities + mappers, the repository port + adapter, and the migration that creates `product` and `product_variant`. No use cases are added here — task-03 onward consumes the repository port introduced in this task.

The aggregate boundary is non-negotiable: on **writes**, `ProductVariant` is a child loaded and saved through the `Product` aggregate root; the repository port has no `findVariantById`/`saveVariant`. The read path (task-05) is allowed to query variants top-level because the read path bypasses domain invariants — it's projection over the same tables.

## Entry state assumed

Task-01 carryover present:

- `apps/catalog-microservice/` boots empty; `CatalogModule` (`infrastructure/catalog.module.ts`) exists as a placeholder.
- `MicroserviceQueueEnum.CATALOG_QUEUE` and `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE` are defined.
- `apps/catalog-microservice/src/app/app.module.ts` imports `DatabaseModule.forRoot([])` with an empty entity list — this task replaces `[]` with `[ProductEntity, ProductVariantEntity]`.
- No migration exists for the `product` or `product_variant` tables.

## Scope

**In:**

- Domain aggregates: `Product` (root), `ProductVariant` (child entity), `ProductStatus` and `VariantStatus` enums or string-literal types, `OptionValues` and `Dimensions` value objects, `Slug` and `Sku` value objects (enforce regex + case-normalisation at construction).
- TypeORM entities: `ProductEntity`, `ProductVariantEntity`.
- Mappers: `ProductMapper.toDomain/toEntity` materialising the variant list as part of the aggregate; `ProductVariantMapper` is a private helper used by `ProductMapper`.
- Repository port + adapter: `IProductRepositoryPort` with the methods listed below; `ProductTypeormRepository` implements it via TypeORM `Repository<ProductEntity>` with `relations: ['variants']`.
- Migration `CreateProductAndProductVariantTables`.
- Domain specs (the two listed in the epic's Test Strategy): `product.model.spec.ts`, `product-variant.model.spec.ts`.
- Doc deliverables: `02-product-and-variant-domain.md` + `03-product-and-variant-persistence.md`.

**Out:**

- Any use case (`Register Product`, `Add Variant`, `Publish Product`, `Archive Product`) — task-03 and task-04.
- Any event publisher port — task-03.
- Any controller/`@MessagePattern` handler — task-05.
- The inventory side's references to the old `product` table — task-08 (this task does **not** drop the old table; the new tables live alongside it until task-08 lands).
- Category, MediaAsset, Price, TaxCategory — out per the epic's Non-Goals.

## Domain shape

### `Product` aggregate root

`apps/catalog-microservice/src/modules/catalog/domain/product.model.ts`. Extends the shared `AggregateRoot<number>` from `libs/ddd/` (the existing convention — confirm by reading the auth or stock aggregate roots). Fields:

- `id: number` (auto-increment integer PK — matches the rest of the schema's `BaseEntity` shape per ADR-019).
- `name: string` (non-empty, trimmed).
- `slug: Slug` (value object — see below).
- `description: string` (optional; default empty string).
- `status: ProductStatus` — one of `'draft' | 'active' | 'archived'`.
- `variants: ProductVariant[]` — loaded as part of the aggregate; never empty for `status='active'`.
- `createdAt: Date`, `updatedAt: Date` (BaseEntity timestamps).

Static factory `Product.create({ name, slug, description? }): Product` returns a draft with `variants = []`.

Static factory `Product.rehydrate({...})` reconstructs the aggregate from persistence including the loaded variants.

Methods:

- `addVariant(input): ProductVariant` — appends a new variant; returns the created variant for the use case to read its id post-save.
- `publish(): void` — guards `status === 'draft'`, `variants.length >= 1`; flips to `'active'`. The "≥1 active Price" precondition is enforced post-`epic-03`; until then, the use case (task-04) logs a warning when no price exists but does not block. **The model layer does not enforce the price precondition** — that's the use case's responsibility because the model has no visibility into the pricing bounded context.
- `archive(): void` — guards `status === 'active'`; flips to `'archived'`.
- `getVariantById(variantId: number): ProductVariant | undefined`.

Invariants enforced by the model:

- `name` non-empty (`name.trim().length >= 1`).
- `slug` valid (handled by the `Slug` VO).
- `status` transitions: only `draft → active`, `active → archived`. No `archived → draft`, no `archived → active`, no `draft → archived` (archive is only legal from `active`).
- `publish()` rejects when `variants.length === 0` with a domain error `ProductHasNoVariantsError`.

### `ProductVariant` child entity

`apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts`. Not an aggregate root — it's a child of `Product`. Fields:

- `id: number`.
- `productId: number`.
- `sku: Sku` (value object — see below).
- `gtin: string | null` — optional EAN/UPC/GTIN-14; if present, must satisfy the GTIN check-digit rule (helper in the VO; or accept a loose `/^\d{8,14}$/` and defer real validation to a follow-up — pick the loose validation; check-digit verification belongs in a Cross-Cutting helper later).
- `optionValues: OptionValues` — non-empty map (e.g. `{ color: 'red', size: 'M' }`).
- `weightG: number | null` — non-negative integer; null permitted.
- `dimensionsMm: Dimensions | null` — `{ l, w, h }` in millimetres; if present, each side is a non-negative integer.
- `status: VariantStatus` — `'active' | 'archived'`.

Invariants:

- `sku` valid (handled by the VO).
- `optionValues` has at least one entry.
- `weightG` non-negative if present.
- Each dimension side non-negative if present.

### Value objects (siblings of the models)

`apps/catalog-microservice/src/modules/catalog/domain/value-objects/`:

- `slug.vo.ts` — `Slug` enforces `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, lowercases on construction, max length 200.
- `sku.vo.ts` — `Sku` enforces `/^[A-Z0-9][A-Z0-9-_]*$/i` (case-insensitive), uppercases on construction, max length 64.
- `option-values.vo.ts` — `OptionValues` wraps `Record<string, string>`; rejects empty maps; freezes the record on construction.
- `dimensions.vo.ts` — `Dimensions` wraps `{ l: number; w: number; h: number }`; rejects negative.

Each VO has a tiny sibling spec (one `describe` per VO is enough — table-driven valid/invalid inputs).

## Persistence shape

### `ProductEntity`

`apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product.entity.ts`. Extends `BaseEntity` (shared `id`/`createdAt`/`updatedAt`). Columns:

- `name: varchar(255) NOT NULL`.
- `slug: varchar(200) NOT NULL UNIQUE` — explicit unique index.
- `description: text NULL`.
- `status: enum('draft','active','archived') NOT NULL DEFAULT 'draft'`.
- `variants: OneToMany(() => ProductVariantEntity, v => v.product)`.

### `ProductVariantEntity`

`apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-variant.entity.ts`. Columns:

- `productId: int NOT NULL` (FK).
- `product: ManyToOne(() => ProductEntity, p => p.variants, { onDelete: 'RESTRICT' })` — refuses cascade deletes; the path is archival, not deletion.
- `sku: varchar(64) NOT NULL UNIQUE`.
- `gtin: varchar(14) NULL` (no unique index in the initial migration — partial-unique is engine-dependent; revisit when MySQL 8 in CI exposes the right syntax).
- `optionValues: json NOT NULL`.
- `weightG: int NULL`.
- `dimensionsMm: json NULL`.
- `status: enum('active','archived') NOT NULL DEFAULT 'active'`.

### Migration

`migrations/<ts>-CreateProductAndProductVariantTables.ts`. `up`:

- `CREATE TABLE product` (columns above; `slug` UNIQUE; `status` ENUM).
- `CREATE TABLE product_variant` (columns above; `sku` UNIQUE; `product_id` FK with `ON DELETE RESTRICT`).
- Charset `utf8mb4_unicode_ci`.

`down`: `DROP TABLE product_variant; DROP TABLE product;` (variant first — FK direction).

Generate via `yarn migration:create migrations/CreateProductAndProductVariantTables` and fill the bodies.

### Mapper

`product.mapper.ts` exposes `toDomain(entity: ProductEntity): Product` and `toEntity(domain: Product): ProductEntity`. The mapper is responsible for translating the persisted `optionValues: object` back into the `OptionValues` VO (validation runs at the construction site — if persistence ever contains an invalid map, the rehydrate path throws a clearly named `PersistenceCorruptedError` and the use case surfaces a 500). Variant mapping is inlined as a private helper inside `product.mapper.ts` — there is no public `ProductVariantMapper` export, because variants are only mapped as part of the aggregate.

### Repository port + adapter

`apps/catalog-microservice/src/modules/catalog/application/ports/product.repository.port.ts`:

```ts
export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

export interface IProductRepositoryPort {
  findById(id: number): Promise<Product | null>;
  findBySlug(slug: string): Promise<Product | null>;
  findByVariantSku(sku: string): Promise<Product | null>; // for AddVariant's duplicate-SKU pre-check
  findActiveProducts(input: { page: number; pageSize: number; search?: string }): Promise<{ rows: Product[]; total: number }>;
  save(product: Product): Promise<Product>;
}
```

The adapter `product-typeorm.repository.ts` uses `relations: ['variants']` on every read so the aggregate is always returned hydrated. `save` is implemented via `repository.save(productEntity)` — TypeORM's cascade on `variants` is **disabled** because the OneToMany side does not cascade; variants are saved explicitly inside the adapter via a transactional helper (the `Add Variant` use case calls `save(product)` and the adapter persists the new variant entry within the same transaction).

The repository is registered under DI token `PRODUCT_REPOSITORY` in the same `CatalogModule` that already exists as a placeholder.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/domain/product.model.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/value-objects/slug.vo.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/value-objects/sku.vo.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/value-objects/option-values.vo.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/value-objects/dimensions.vo.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/errors/` — `product-has-no-variants.error.ts`, `invalid-product-status-transition.error.ts`, `duplicate-slug.error.ts`, `duplicate-sku.error.ts`, `product-not-found.error.ts`, `variant-not-found.error.ts`. Each extends a base `CatalogDomainError`.
- `apps/catalog-microservice/src/modules/catalog/domain/spec/product.model.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/spec/product-variant.model.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/value-objects/spec/` — one tiny spec per VO.
- `apps/catalog-microservice/src/modules/catalog/application/ports/product.repository.port.ts` (port + token).
- `apps/catalog-microservice/src/modules/catalog/application/ports/index.ts` (barrel).
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product.entity.ts`.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-variant.entity.ts`.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product.mapper.ts`.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-typeorm.repository.ts`.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/index.ts` (barrel).
- `migrations/<ts>-CreateProductAndProductVariantTables.ts`.
- `docs/implementation/epic-02-catalog-product-and-variant/02-product-and-variant-domain.md`.
- `docs/implementation/epic-02-catalog-product-and-variant/03-product-and-variant-persistence.md`.

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — register the two entities under `TypeOrmModule.forFeature([ProductEntity, ProductVariantEntity])` and provide `ProductTypeormRepository` under `PRODUCT_REPOSITORY`. Export the repository token + the module so task-03 onward can `imports: [CatalogModule]`.
- `apps/catalog-microservice/src/app/app.module.ts` — replace `DatabaseModule.forRoot([])` with `DatabaseModule.forRoot([ProductEntity, ProductVariantEntity])`.

## Files to delete

None. (The inventory-microservice's old `product` table is dropped in task-08, not here.)

## Tests

- **`product.model.spec.ts`** — invariants:
  - `Product.create` returns `status='draft'`, `variants=[]`.
  - `publish()` rejects when `variants.length === 0` (`ProductHasNoVariantsError`).
  - `publish()` rejects when `status !== 'draft'` (`InvalidProductStatusTransitionError`).
  - `archive()` rejects when `status !== 'active'`.
  - `addVariant()` appends; the returned variant has the parent's `productId`.
  - State machine: legal transitions only (table-driven `from → to` with the four illegal combinations explicitly rejected).
- **`product-variant.model.spec.ts`** — invariants:
  - `optionValues` non-empty (rejects `{}`).
  - `weightG` non-negative (rejects `-1`; accepts `0` and positive integers).
  - `gtin` accepts `null`, accepts `'04902430735063'`, rejects `'abc'`.
- **VO specs** — minimal table-driven coverage:
  - `slug.vo.spec.ts`: accepts `'mens-shirt-red'`; rejects `'Mens-Shirt'`, `'-leading-dash'`, `''`.
  - `sku.vo.spec.ts`: accepts `'SKU-RED-M-001'`; lowercases to uppercase; rejects `' '`, `''`.
  - `option-values.vo.spec.ts`: accepts a non-empty map; rejects `{}`; freezes the map (mutation throws in strict mode).
  - `dimensions.vo.spec.ts`: accepts `{ l: 1, w: 1, h: 1 }`; rejects `{ l: -1, … }`.
- **Migration round-trip** — verified manually: `yarn migration:run` applies; `yarn migration:revert` drops both tables; `yarn migration:run` applies again. No tests required (the existing suite has no migration-round-trip harness).
- **No e2e tests in this task** — there is no HTTP surface yet (task-06 adds the controller; the gateway e2e covers it under task-09's seed pass).

## Doc deliverable — `02-product-and-variant-domain.md`

Target ~180 lines. Sections:

1. **The aggregate boundary.** `Product` is the aggregate root; `ProductVariant` is a child entity. The write side loads/saves variants only through the Product aggregate — the repository port has no `findVariantById`/`saveVariant`. The read side (task-05) is exempt because read paths are projections, not domain operations.
2. **Status state machine.** A small ASCII diagram: `draft → active → archived`. Illegal edges are enumerated; each illegal transition has a corresponding domain error class.
3. **Invariants enforced by the model vs. by the repository.** The model enforces "≥1 variant before publish"; uniqueness of `slug` and `sku` is enforced by the repository's DB constraint + a pre-check that surfaces a typed domain error (`DuplicateSlugError`, `DuplicateSkuError`) rather than letting TypeORM's `QueryFailedError` leak out.
4. **The Price precondition (deferred to `epic-03`).** A short forward reference: the model deliberately does not check for "≥1 active Price" because pricing lives in another bounded context. The use case logs a warning until `epic-03` is merged; then the use case becomes the enforcement point. The model layer remains free of pricing knowledge.
5. **Value objects vs. primitives.** Why `Slug`/`Sku`/`OptionValues`/`Dimensions` are VOs (single point of validation, freezable, comparable by value). Why `gtin` is left as a raw `string | null` for now (real GTIN check-digit verification is a Cross-Cutting helper that doesn't exist yet — flagged in `epic-15`'s exclusions register).
6. **Soft-delete via `status`, not `deletedAt`.** Cite Cross-Cutting "Soft delete vs hard delete". An archived Product remains resolvable forever because historical Orders reference it by id (or, after `epic-04`, by variantId).
7. **What this task did NOT do.** Forward references to task-03 (write use cases + events), task-04 (publish/archive), task-05 (read path), task-08 (drop old inventory table).

## Doc deliverable — `03-product-and-variant-persistence.md`

Target ~150 lines. Sections:

1. **Tables created.** `product` and `product_variant` (column lists mirror "Persistence" above).
2. **Indexes & constraints.** Unique index on `product.slug`; unique index on `product_variant.sku`; nullable `gtin` without a partial-unique index (rationale: MySQL 8 nullable-aware partial-unique is engine-quirky; revisit). FK `product_variant.product_id → product.id ON DELETE RESTRICT` — refuses cascade delete because the path is archival.
3. **Why `INT` PKs, not `CHAR(36)`.** Catalog rows are not addressable from outside-system clients before publication; the table joins to the rest of the schema (StockLevel, OrderLine) all key on integer ids. A UUID PK would buy nothing and cost index bytes.
4. **Mapper rationale.** Why `ProductVariantMapper` is a private helper inside `product.mapper.ts`: the variant is only mapped as part of the aggregate; exposing a top-level variant mapper would invite a use case to fetch a variant outside the aggregate.
5. **Repository port shape.** Why `findByVariantSku` exists at the repo level (it's a pre-check for `Add Variant` to surface a typed `DuplicateSkuError` before the DB raises a `QueryFailedError`). Why no `update`/`delete` methods — soft-delete via the aggregate's `archive()` is the only path.
6. **Concurrency note.** No `@VersionColumn` on Product/ProductVariant (Cross-Cutting §1 — last-writer-wins is acceptable; catalog is not in the no-oversell critical path). This will be revisited if `epic-12` (idempotency + optimistic concurrency) requires it for category-attach or similar.
7. **What this task did NOT do.** Forward references to task-08 (drop old inventory `product` table) and `epic-04` (inventory's references shift to `variantId`).

## Carryover produced (consumed by task-03 onward)

- Domain model and value objects are in place; `Product.create`, `Product.addVariant`, `Product.publish`, `Product.archive` are callable from a use case.
- `IProductRepositoryPort` + `PRODUCT_REPOSITORY` token are exported by the `CatalogModule`.
- `ProductEntity` + `ProductVariantEntity` are registered in `DatabaseModule.forRoot([...])`.
- New migration is present in `migrations/`.
- Docs `02-product-and-variant-domain.md` and `03-product-and-variant-persistence.md` exist.
- The inventory-microservice's old `product` table still exists in the schema (task-08 removes it).

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; ≥4 new spec files are green (the two model specs + the VO specs).
- [ ] `yarn migration:run` applies cleanly on a fresh DB; `yarn migration:revert` drops the two new tables cleanly; re-running `migration:run` succeeds.
- [ ] `yarn start:dev:catalog-microservice` boots without "entity not registered" errors.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Docs `02-product-and-variant-domain.md` and `03-product-and-variant-persistence.md` exist at the paths above and are filled per the section lists.
