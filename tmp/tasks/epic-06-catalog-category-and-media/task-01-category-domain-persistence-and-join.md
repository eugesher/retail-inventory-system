---
epic: epic-06
task_number: 1
title: Add Category domain + persistence + product_categories join + creation migration
depends_on: [epic-02]
doc_deliverable_primary: docs/implementation/06-catalog-category-and-media/01-category-hierarchy-and-materialized-path.md
---

# Task 01 — `Category` domain + persistence + `product_categories` join

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For decisions this task touches, open the original ADRs:
  - [ADR-004](../../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) / [ADR-009](../../../docs/adr/009-port-adapter-at-the-gateway.md) — the per-module hexagonal split; `Category` lives **inside** the existing `catalog` module, not as a new bounded context.
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — `BaseEntity` shape, `SnakeNamingStrategy`, hand-authored migrations, `synchronize: false`, the `ITransactionPort` rule for transactional work.
  - [ADR-017](../../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) — domain imports nothing outside `libs/{ddd,common,contracts}`; no `@nestjs/*`/TypeORM/`class-validator` in `domain/`.

## Goal

Land the `Category` aggregate, its persistence, and the `product_categories` join table inside the existing `apps/catalog-microservice/src/modules/catalog/` tree. `Category` is a self-hierarchical merchandising classification with a `parentId` and a **materialized `path`** (e.g. `/menswear/shirts/oxford`) that is regenerated on every reparent. No use cases are added here — task-02 (`Create`/`Reparent`) and task-03 (`Reclassify`/`Browse`) consume the repository port introduced in this task.

The hard rule this task encodes in the domain layer: **a category may not become its own ancestor** (no cycles), and the `path` is a *pure function* of the category's `slug` plus its ancestor chain — the domain exposes the regeneration logic; the use case (task-02) drives the transaction that persists it across the subtree.

## Entry state assumed

`epic-02` is merged:

- `apps/catalog-microservice/` boots; `modules/catalog/` holds the `Product`/`ProductVariant` aggregates, the `Slug` value object (`domain/value-objects/slug.vo.ts`), the `CatalogDomainError` base (`domain/errors/`), `ProductEntity`/`ProductVariantEntity`, and the `CatalogModule` that registers entities + the `PRODUCT_REPOSITORY` provider.
- `DatabaseModule.forRoot([...])` in `apps/catalog-microservice/src/app/app.module.ts` lists the catalog entities — this task appends `CategoryEntity`.
- No `category` / `product_categories` tables exist.

## Scope

**In:**

- Domain: `Category` aggregate (`domain/category.model.ts`), reusing the existing `Slug` VO for `slug`. `CategoryStatus` = `'active' | 'archived'` (soft-delete via status — Cross-Cutting "Soft delete vs hard delete"). A pure `regeneratePath(parentPath: string | null): string` helper and a `wouldCreateCycle(candidateAncestorIds: number[]): boolean` guard.
- New domain errors extending `CatalogDomainError`: `CategoryNotFoundError`, `DuplicateCategorySlugError`, `CategoryCycleError`.
- Persistence: `CategoryEntity` (self-referential FK), `CategoryMapper`, `ICategoryRepositoryPort` + `CATEGORY_REPOSITORY` token, `CategoryTypeormRepository`.
- The `product_categories` join: a `ProductCategoryEntity` (composite PK `(product_id, category_id)`) **plus** the repository methods the reclassify use case (task-03) will call (`attachProductToCategory`, `detachProductFromCategory`, `findCategoriesForProduct`, `findProductIdsForCategoryPaths`). The *use cases* that call them are task-03; the *port surface + adapter* land here so task-03 only writes application code.
- Migration `CreateCategoryAndProductCategoriesTables`.
- Domain spec `domain/spec/category.model.spec.ts` (kebab-case slug invariant via the `Slug` VO; cycle guard; `path` regeneration semantics).
- Doc deliverable: the persistence + cycle half of `01-category-hierarchy-and-materialized-path.md`.

**Out:**

- `Create`/`Reparent` use cases — task-02.
- `Reclassify`/`Browse` use cases and the `@MessagePattern` handlers that call the join methods — task-03.
- `MediaAsset` — task-04.
- Any api-gateway change — task-06.
- Emitting any domain event (category edits are not in the must-emit set — see the epic's Architectural Decisions).

## Domain shape

### `Category` aggregate

`apps/catalog-microservice/src/modules/catalog/domain/category.model.ts`. Extends `AggregateRoot<number>` from `libs/ddd/` (confirm the convention against `epic-02`'s `Product`). Fields:

- `id: number` (auto-increment integer PK, per ADR-019 `BaseEntity`).
- `name: string` — non-empty, trimmed.
- `slug: Slug` — reuse the existing `Slug` VO (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, lowercased, max 200). Do **not** clone a second slug VO.
- `parentId: number | null` — null for a root category.
- `path: string` — materialized, e.g. `/electronics/phones`. A root's path is `/<slug>`; a child's path is `<parentPath>/<slug>`.
- `sortOrder: number` — default 0.
- `status: CategoryStatus` — `'active' | 'archived'`.
- `createdAt` / `updatedAt` (BaseEntity timestamps).

Factories:

- `Category.createRoot({ name, slug, sortOrder? }): Category` — `parentId = null`, `path = '/' + slug`, `status = 'active'`.
- `Category.createChild({ name, slug, parent, sortOrder? }): Category` — `parentId = parent.id`, `path = parent.path + '/' + slug`.
- `Category.rehydrate({...})` — reconstruct from persistence (path comes straight from the column; never recomputed on read).

Methods:

- `regeneratePath(parentPath: string | null): void` — sets `path = (parentPath ?? '') + '/' + this.slug.value`. Pure given the argument; the use case supplies the freshly-computed parent path during a reparent walk.
- `reparentTo(parent: Category | null, descendantIds: number[]): void` — guards the cycle rule: throws `CategoryCycleError` if `parent` is `this` or `parent.id ∈ descendantIds`; otherwise sets `parentId` and calls `regeneratePath(parent?.path ?? null)`. (The descendant-subtree recompute is orchestrated by the use case in task-02 — this method updates *this* node and validates the move.)
- `archive(): void` — guards `status === 'active'`; flips to `'archived'`.

Invariants:

- `name` non-empty.
- `slug` valid (delegated to the `Slug` VO).
- A category is never its own parent; a category may not be reparented under one of its own descendants (`CategoryCycleError`).
- `path` always begins with `/` and contains each ancestor slug in order.

## Persistence shape

### `CategoryEntity`

`apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/category.entity.ts`. Extends `BaseEntity`. Columns (camelCase fields → snake_case via `SnakeNamingStrategy`; no `@Column({ name })` overrides):

- `name: varchar(255) NOT NULL`.
- `slug: varchar(200) NOT NULL` — unique index.
- `parentId: int NULL` — self-FK.
- `parent: ManyToOne(() => CategoryEntity, c => c.children, { onDelete: 'SET NULL' })` — a deleted parent demotes its children to root (the use case then recomputes their paths).
- `children: OneToMany(() => CategoryEntity, c => c.parent)`.
- `path: varchar(512) NOT NULL` — indexed (prefix-searchable for `includeDescendants` browse).
- `sortOrder: int NOT NULL DEFAULT 0`.
- `status: enum('active','archived') NOT NULL DEFAULT 'active'`.

### `ProductCategoryEntity` (join)

`apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-category.entity.ts`. Composite PK `(productId, categoryId)`; both columns are FKs with `ON DELETE CASCADE` (removing a product or category drops the membership rows, never the historic Product/Category itself). No timestamps required, but `BaseEntity` is fine if simpler — prefer a slim `@Entity` with two `@PrimaryColumn`s to keep the join narrow.

### Migration

`migrations/<ts>-CreateCategoryAndProductCategoriesTables.ts`, generated via `yarn migration:create migrations/CreateCategoryAndProductCategoriesTables`. `up`:

- `CREATE TABLE category` (columns above; `slug` UNIQUE; `path` indexed; `parent_id` indexed; self-FK `parent_id → category.id ON DELETE SET NULL`).
- `CREATE TABLE product_categories` (`product_id` INT, `category_id` INT, composite PK; FK `product_id → product.id ON DELETE CASCADE`; FK `category_id → category.id ON DELETE CASCADE`).
- Charset `utf8mb4_unicode_ci`.

`down`: `DROP TABLE product_categories; DROP TABLE category;` (join first — FK direction).

### Mapper

`category.mapper.ts` — `toDomain(entity): Category` (calls `Category.rehydrate`, materialising `path` straight from the column) and `toEntity(domain): CategoryEntity`. No public child mapper — `children`/`parent` relations are navigated by the repository, not mapped into the aggregate (the aggregate carries only `parentId`, not a nested tree).

### Repository port + adapter

`apps/catalog-microservice/src/modules/catalog/application/ports/category.repository.port.ts`:

```ts
export const CATEGORY_REPOSITORY = Symbol('CATEGORY_REPOSITORY');

export interface ICategoryRepositoryPort {
  findById(id: number): Promise<Category | null>;
  findBySlug(slug: string): Promise<Category | null>;
  /** All categories whose path starts with `${ancestor.path}/` — the subtree, excluding the ancestor itself. */
  findDescendants(ancestorPath: string): Promise<Category[]>;
  /** Active children of a parent (parentId null → roots), ordered by sortOrder. */
  findChildren(parentId: number | null): Promise<Category[]>;
  save(category: Category): Promise<Category>;
  /** Persist many in one call (used by the reparent subtree recompute in task-02). */
  saveMany(categories: Category[], scope?: ITransactionScope): Promise<void>;

  // product_categories join (consumed by task-03's Reclassify/Browse use cases):
  attachProductToCategory(productId: number, categoryId: number): Promise<void>; // idempotent (INSERT IGNORE / ON CONFLICT DO NOTHING)
  detachProductFromCategory(productId: number, categoryId: number): Promise<void>;
  findCategoriesForProduct(productId: number): Promise<Category[]>;
  findProductIdsForCategoryPaths(paths: string[]): Promise<number[]>;
}
```

`category-typeorm.repository.ts` implements it via `Repository<CategoryEntity>`. `findDescendants` uses a `LIKE` prefix match on `path` (`path LIKE :prefix` with `prefix = ancestorPath + '/%'`). `saveMany` accepts the opaque `ITransactionScope` from `epic-04`/ADR-017's `ITransactionPort` so task-02's reparent runs in one transaction — **do not** import `EntityManager` into the use case; the adapter downcasts the scope per ADR-017 §6.

Register `CategoryTypeormRepository` under `CATEGORY_REPOSITORY` in `CatalogModule`; export the token so task-02/03 can inject it. If the catalog module does not already provide `TRANSACTION_PORT`, add the `TypeormTransactionAdapter` binding here (mirror the inventory `stock.module.ts` shape) — task-02 needs it.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/domain/category.model.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/errors/category-not-found.error.ts`, `duplicate-category-slug.error.ts`, `category-cycle.error.ts` (each `extends CatalogDomainError`).
- `apps/catalog-microservice/src/modules/catalog/domain/spec/category.model.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/ports/category.repository.port.ts` (+ update the `application/ports/index.ts` barrel).
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/category.entity.ts`.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-category.entity.ts`.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/category.mapper.ts`.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/category-typeorm.repository.ts`.
- `migrations/<ts>-CreateCategoryAndProductCategoriesTables.ts`.
- `docs/implementation/06-catalog-category-and-media/01-category-hierarchy-and-materialized-path.md` (persistence + cycle half; task-02 completes it).

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — register `CategoryEntity` + `ProductCategoryEntity` (`DatabaseModule.forFeature(...)` or the inline `TypeOrmModule.forFeature(...)` already used — match the module's existing style per the ADR-019 amendment); provide `CategoryTypeormRepository` under `CATEGORY_REPOSITORY` and (if absent) `TypeormTransactionAdapter` under `TRANSACTION_PORT`; export both tokens.
- `apps/catalog-microservice/src/app/app.module.ts` — append `CategoryEntity` + `ProductCategoryEntity` to `DatabaseModule.forRoot([...])`.

## Files to delete

None.

## Tests

`domain/spec/category.model.spec.ts`:

- `Category.createRoot({ slug: 'electronics' })` → `path === '/electronics'`, `parentId === null`, `status === 'active'`.
- `Category.createChild` with a parent whose `path` is `/electronics` and slug `phones` → `path === '/electronics/phones'`.
- `regeneratePath('/apparel')` on a node with slug `phones` → `path === '/apparel/phones'`.
- `reparentTo(self, [...])` throws `CategoryCycleError`.
- `reparentTo(parent, descendantIds)` where `parent.id ∈ descendantIds` throws `CategoryCycleError`.
- A legal reparent updates `parentId` and `path` for the node.
- Invalid slug (`'Electronics'`, `'-leading'`) rejected by the `Slug` VO at construction.

No e2e in this task (no HTTP surface yet — task-06). Migration round-trip is verified manually: `yarn migration:run` → `yarn migration:revert` → `yarn migration:run`.

## Doc deliverable — `01-category-hierarchy-and-materialized-path.md` (this task writes the first half)

Target ~120 lines for this half (task-02 appends the reparent-algorithm section). Sections:

1. **Why a materialized `path` over a closure-table.** Browse-by-category-with-descendants is a single indexed `LIKE '/electronics/%'` prefix scan; reads dominate writes for a catalog tree, and reparent (the only write that rewrites many rows) is rare. A closure-table would add a second table and O(depth²) maintenance rows for a read pattern a prefix index already serves. Trade-off stated honestly: reparent is O(subtree-size) row updates, accepted because reparent is an admin-rare operation.
2. **Path format + invariants.** Leading `/`; each ancestor slug in order; root is `/<slug>`. `path` is regenerated, never user-supplied.
3. **Cycle detection.** Encoded in the domain (`reparentTo` rejects self-parent and descendant-parent). The descendant set is supplied by the use case (task-02) via `findDescendants(path)`.
4. **Self-FK `ON DELETE SET NULL`.** A deleted parent demotes children to root; the use case recomputes their paths on the same transaction (forward ref to task-02).
5. **Soft-delete via `status`.** Cross-Cutting "Soft delete vs hard delete": archived categories are excluded from browse but remain referenceable for historic Product←Category memberships.
6. **What this task did NOT do.** Forward refs to task-02 (use cases + recompute) and task-03 (reclassify/browse).

## Carryover produced (consumed by task-02 onward)

- `Category` aggregate + its errors are callable from a use case; the cycle guard and `regeneratePath` exist.
- `ICategoryRepositoryPort` + `CATEGORY_REPOSITORY` are exported by `CatalogModule`; `TRANSACTION_PORT` is available in the catalog module.
- `category` + `product_categories` tables exist via migration; `CategoryEntity` is registered in `DatabaseModule.forRoot`.
- The persistence/cycle half of `01-…md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); no boundaries-rule edits were needed.
- [ ] `yarn test:unit` passes; `category.model.spec.ts` is green.
- [ ] `yarn migration:run` applies cleanly on a fresh DB; `yarn migration:revert` drops both new tables; re-running `migration:run` succeeds.
- [ ] `yarn start:dev:catalog-microservice` boots without "entity not registered" errors.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] `01-category-hierarchy-and-materialized-path.md` exists with the sections above.
