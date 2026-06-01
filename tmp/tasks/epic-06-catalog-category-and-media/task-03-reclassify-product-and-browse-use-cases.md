---
epic: epic-06
task_number: 3
title: Implement Reclassify Product + Browse-by-Category use cases over the product_categories join
depends_on: [epic-02, task-01, task-02]
doc_deliverable_primary: docs/implementation/06-catalog-category-and-media/02-product-categories-join.md
---

# Task 03 — `Reclassify Product` + `Browse by Category` use cases

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-004](../../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) — read paths are projections over the same tables; they may query outside the aggregate.
  - [ADR-008](../../../docs/adr/008-rabbitmq-via-libs-messaging.md) — dotted routing-key format; new constants in `libs/messaging`.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) / [ADR-011](../../../docs/adr/011-notifier-port-and-adapters.md) — `PinoLogger`; inline `correlationId` inside `@MessagePattern` handlers.
  - Epic §"Architectural Decisions Honored" — category/media edits are **not** in the must-emit set: **Reclassify emits no event**.

## Goal

Let an admin attach/detach categories on a product (idempotently) and let a customer browse active products under a category — optionally including its descendant subtree. Both run on task-01's `product_categories` join methods and task-01's `path`-prefix descendant query. No domain events are emitted (the report classifies catalog-navigation reshape as a read-side concern).

## Entry state assumed

`epic-02` merged; tasks 01–02 carryover present:

- `ICategoryRepositoryPort` exposes `attachProductToCategory`, `detachProductFromCategory`, `findCategoriesForProduct`, `findProductIdsForCategoryPaths`, `findDescendants`, `findBySlug`.
- `IProductRepositoryPort` (`epic-02`) exposes `findById` and an active-products query; `CategoryView` DTO exists.
- The catalog controller already hosts product/variant/category `@MessagePattern` handlers.

## Scope

**In:**

- `application/use-cases/reclassify-product.use-case.ts` (attach + detach in one use case, or two thin use cases sharing a command — prefer one use case with an `action: 'attach' | 'detach'` or two methods; match `epic-02`'s use-case granularity) + spec.
- `application/use-cases/browse-by-category.use-case.ts` + spec.
- DTOs: `ReclassifyProductCommand` (`{ productId, categorySlugs[], action }` or attach/detach variants), `BrowseByCategoryQuery` (`{ slug, includeDescendants?, page?, pageSize? }`), `BrowseByCategoryView` (paginated active products).
- `@MessagePattern` handlers + routing keys: `CATALOG_PRODUCT_RECLASSIFY = 'catalog.product.reclassify'`, `CATALOG_PRODUCT_DETACH_CATEGORY = 'catalog.product.detach-category'`, `CATALOG_CATEGORY_BROWSE = 'catalog.category.browse'` (request/response RPC, not bus events).
- Doc deliverable `02-product-categories-join.md`.

**Out:**

- `MediaAsset` — task-04.
- The category-tree read (`GET …/:slug/tree`) and flat-list read — those gateway reads map to a simple `findChildren`/`findDescendants` RPC; add a `CATALOG_CATEGORY_LIST`/`CATALOG_CATEGORY_TREE` handler here **only** if task-06 needs it (see task-06). Keep this task focused on reclassify + browse-products; add the list/tree read handler here as a thin extra if convenient, otherwise task-06 notes the dependency.
- api-gateway controller/DTOs — task-06.

## Use-case shapes

### `ReclassifyProductUseCase`

Attach input `{ productId: number; categorySlugs: string[]; correlationId: string }`:

1. `productRepo.findById(productId)` → `ProductNotFoundError` if missing.
2. For each slug: `categoryRepo.findBySlug(slug)` → `CategoryNotFoundError` if any is unknown (validate all before mutating — fail the whole request on the first unknown slug; do not partially attach).
3. For each resolved category: `attachProductToCategory(productId, categoryId)` — idempotent at the repo layer (`INSERT … ON DUPLICATE KEY UPDATE`/`INSERT IGNORE`), so re-attaching an existing membership is a no-op, not an error.
4. Return the updated product header (`findCategoriesForProduct` to include the current membership list).

Detach input `{ productId, categorySlug }`: resolve the category, `detachProductFromCategory` (no-op if not attached), return the updated header.

**No event is emitted.** Log at `info` inline `correlationId`.

### `BrowseByCategoryUseCase` (public read)

Input `{ slug: string; includeDescendants?: boolean; page?: number; pageSize?: number }`:

1. `findBySlug(slug)` → `CategoryNotFoundError` if missing or archived (archived categories are excluded from browse).
2. Build the path set: just `[category.path]` when `includeDescendants` is false/absent; `[category.path, ...descendants.map(d => d.path)]` when true (`findDescendants(category.path)`, active only).
3. `findProductIdsForCategoryPaths(paths)` → product ids; intersect with **active** products (`status='active'`) via the product repo's active-products query, paginated.
4. Return `IPage<ProductHeaderView>` (use `libs/common` pagination types).

This is a projection read — it queries the join + products tables directly and does not load the `Product` aggregate's invariants (ADR-004 read-path exemption).

## Files to add

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/reclassify-product.use-case.ts` + `spec/reclassify-product.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/browse-by-category.use-case.ts` + `spec/browse-by-category.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/dto/reclassify-product.command.ts`, `browse-by-category.query.ts`, `browse-by-category.view.ts` (+ barrel).
- `docs/implementation/06-catalog-category-and-media/02-product-categories-join.md`.

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts` — `@MessagePattern` handlers for reclassify (attach), detach, and browse.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — register the new use cases.
- `libs/messaging/routing-keys.constants.ts` — add the new routing keys.

## Files to delete

None.

## Tests

`reclassify-product.use-case.spec.ts`:

- Attach two categories → both `attachProductToCategory` calls made; returned header lists both.
- Re-attach an already-attached category → idempotent (no throw; repo call is a no-op INSERT).
- Unknown product → `ProductNotFoundError`; no attach calls.
- One unknown slug in the list → `CategoryNotFoundError`; **no** partial attach (all-or-nothing validation before mutation).
- Detach a non-attached category → no-op, no throw.
- **No event publisher is injected** — assert the use case has no events dependency (this is the design check the epic calls out).

`browse-by-category.use-case.spec.ts`:

- `includeDescendants=false` → only the category's own path queried.
- `includeDescendants=true` → category path + all descendant paths queried; archived descendants excluded.
- Archived target category → `CategoryNotFoundError` (excluded from browse).
- Only `status='active'` products returned; pagination shape (`IPage`) respected.

## Doc deliverable — `02-product-categories-join.md`

Target ~120 lines. Sections:

1. **The N↔M relationship.** A product belongs to many categories; a category holds many products. `product_categories` composite-PK join (FKs `ON DELETE CASCADE` — drops memberships, never the Product/Category).
2. **Idempotent attach.** Why attach is `INSERT … ON DUPLICATE KEY` / `INSERT IGNORE` at the repo layer rather than a read-then-write in the use case (avoids a TOCTOU race and a `QueryFailedError` on the composite PK). Re-classifying is safe to retry.
3. **All-or-nothing slug validation.** Why the use case resolves every slug before mutating — a half-applied reclassify is confusing for an admin; one unknown slug fails the whole request with `CategoryNotFoundError`.
4. **Why no event.** Cross-Cutting "Event emission": category/media reshape is a read-side concern, not in the must-emit set (§2 of the report names `ProductPublished`/`ProductArchived` + stock/order/return events). A future `catalog.category.reparented` cache-invalidation event is noted as optional later work — explicitly out of scope here.
5. **Browse-by-category + `includeDescendants`.** The query is a `path`-prefix scan: own path, or own + descendant paths. Archived categories/products are excluded. Read-path exemption (ADR-004) — this is a projection, not an aggregate load.
6. **What this task did NOT do.** Forward refs to task-04 (media) and task-06 (gateway endpoints).

## Carryover produced (consumed by task-06)

- Reclassify (attach/detach) + browse reachable over RPC.
- `BrowseByCategoryView` paginated shape fixed (task-06 mirrors it).
- `02-product-categories-join.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; both new specs green, including the "no event publisher injected" assertion.
- [ ] `yarn start:dev:catalog-microservice` boots; the new `@MessagePattern` handlers register.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] `02-product-categories-join.md` exists with the sections above.
