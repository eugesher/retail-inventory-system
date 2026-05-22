---
id: epic-06
title: Catalog extensions — Category hierarchy and MediaAsset polymorphism
source_stages: [production-core]
depends_on: [epic-02]
microservices: [api-gateway, catalog-microservice]
task_subfolder: tmp/tasks/epic-06-catalog-category-and-media/
docs_subfolder: docs/implementation/epic-06-catalog-category-and-media/
---

# Epic 06 — Catalog extensions — Category hierarchy and MediaAsset polymorphism

## Goal

Extend the catalog-microservice with the two Stage-2 catalog entities the report names: `Category` (self-hierarchical merchandising classification with `parentId` + materialized `path`) and `MediaAsset` (polymorphic image/video/document attached to either a Product or a ProductVariant). Implement the two Stage-2 catalog operations: Reclassify Product (attach/detach Categories), attach/sort/detach MediaAsset. Lift the Stage-1 Publish-Product recommended-precondition "≥1 active MediaAsset" from a comment-only note to a soft warning surfaced in the publish response (the report explicitly classifies it as "recommended, not strict"). After this epic, customers can browse the catalog by category breadcrumb and pages can render media for products and variants.

## In-Scope Entities and Operations

- **Category**: `id` (INT PK), `name`, `slug` (unique), `parentId` (self-referential FK, nullable for root), `path` (materialized path string, e.g. `/menswear/shirts/oxford`, regenerated on every reparent), `sortOrder`, `createdAt`, `updatedAt`.
- **product_categories** join table: `(product_id, category_id)` composite PK.
- **MediaAsset**: `id`, `uri` (https://… or s3://…), `type` (`image` | `video` | `document`), `altText`, `sortOrder`, `ownerType` (`product` | `product-variant`), `ownerId`, timestamps. Polymorphic owner.
- **Operations:**
  - **Create Category** (User; `catalog:write`) — new category; optional parent.
  - **Reparent Category** (User; `catalog:write`) — change `parentId`; recompute `path` for self + all descendants in one transaction.
  - **Reclassify Product** (User; `catalog:write`) — attach/detach categories on a product; emits no new event in core (catalog navigation reshape is read-side concern).
  - **Browse by Category** (Customer; public) — list active products under a category (and optionally its descendants).
  - **Attach MediaAsset** (User; `catalog:write`) — append to product or variant; `sortOrder` defaults to max+1 within the same owner.
  - **Reorder MediaAsset** (User; `catalog:write`) — bulk reorder.
  - **Detach MediaAsset** (User; `catalog:write`) — soft-delete (status flip), preserving the row for OrderLine snapshots that may have captured the uri historically (defensive — Order doesn't actually snapshot uri today, but the row is referenceable via the event stream).

## Non-Goals

- **Product bundles / kits, dynamic typed attributes (commercetools-style ProductType), configurable products with option dependencies, digital good entitlements, multi-locale translation tables, brand entity, supplier/vendor** — Exclusions Register (`epic-15`).
- **Search / faceting / full-text / Elasticsearch projection** — explicitly out of scope; the report's caveats section notes that search-index projections are scale-out concerns not in the universal core.
- **Asset upload pipeline / S3 wiring / signed URLs** — the `MediaAsset.uri` is treated as an opaque already-uploaded URL. A future upload service is referenced as future work.
- **CDN cache invalidation hooks** — out of scope.

## Architectural Decisions Honored

- **Cross-Cutting "Event emission":** category and media edits are NOT in the must-emit set (the report's §2 names `ProductPublished` / `ProductArchived` and stock/order/return events, not category/media). This epic therefore emits no new domain events. (Optional later: a `catalog.category.reparented` event for cache-invalidation in a future read model.)
- **Cross-Cutting "Soft delete vs hard delete":** Category and MediaAsset are both soft-delete entities — use `status` (active | archived) rather than `deletedAt`. Archived Categories are excluded from browse but referenceable for historic Product←Category memberships.
- **Cross-Cutting "Auditability":** category/media authoring is in the "NOT required at same fidelity" set per the report. This epic therefore does not invoke `AUDIT_LOG_PUBLISHER` on category/media mutations.
- **ADR-004 / 009** (per-module hexagonal): Category and MediaAsset live inside the existing `catalog` module — they are Product-side aggregates, not new bounded contexts.
- **ADR-016 + ADR-022** (cache keys): if a category-tree read becomes hot, key convention `ris:catalog:category-tree:v1` (root-level whole-tree cache) or `ris:catalog:category:v1:<categoryId>:children`. Builders added but not used in this epic.
- **ADR-017** (boundaries): no new module — extends the existing catalog module; boundaries lint should pass without rule changes.
- **ADR-019** (TypeORM + MySQL): new tables via migration; self-referential FK on Category.
- **ADR-010** (RBAC at the gateway): write paths behind `catalog:write`; reads public.

## Persistence Changes

**Added (in catalog-microservice):**

- `category` table: `id` (INT PK), `name`, `slug` (unique), `parent_id` (INT FK to self, nullable), `path` (VARCHAR(512), materialized, indexed), `sort_order` (INT default 0), `status` (ENUM `active` | `archived`), timestamps.
- `product_categories` join table: `(product_id, category_id)` composite PK; FKs to both with `ON DELETE CASCADE`.
- `media_asset` table: `id` (BIGINT PK), `uri` (VARCHAR(1024)), `type` (ENUM), `alt_text` (VARCHAR(255) nullable), `sort_order` (INT default 0), `owner_type` (ENUM `product` | `product-variant`), `owner_id` (INT — opaque per type), `status` (ENUM `active` | `archived`), timestamps.

**Removed:** none.

**Indexes & constraints:**

- Unique index on `category.slug`.
- Index on `category.parent_id`, `category.path` (prefix-searchable).
- Composite index on `media_asset (owner_type, owner_id, sort_order)`.
- Self-FK on `category.parent_id → category.id ON DELETE SET NULL` (a deleted parent demotes descendants to root; recompute path on the same transaction).

## Eventing / Messaging

- **No new routing keys** — see Architectural Decisions above. (Future cache-invalidation events would be additive.)
- **No new consumers or queues.**

## API Surface

**New HTTP endpoints in `api-gateway`** (added to `modules/catalog/`):

| Method | Path | Body / params | Auth | Response |
|---|---|---|---|---|
| `POST` | `/api/catalog/categories` | `{ name, slug, parentSlug? }` | bearer + `catalog:write` | new Category with `path` |
| `PATCH` | `/api/catalog/categories/:slug/parent` | `{ newParentSlug? }` | bearer + `catalog:write` | reparented Category + count of descendants whose `path` was rewritten |
| `GET` | `/api/catalog/categories` | query: `?root=true|false` | `@Public()` | flat list with `path` |
| `GET` | `/api/catalog/categories/:slug/tree` | — | `@Public()` | nested tree |
| `POST` | `/api/catalog/products/:productId/categories` | `{ categorySlugs[] }` | bearer + `catalog:write` | updated product header |
| `DELETE` | `/api/catalog/products/:productId/categories/:categorySlug` | — | bearer + `catalog:write` | updated product header |
| `GET` | `/api/catalog/categories/:slug/products` | query: `?includeDescendants=true|false&page=…` | `@Public()` | paginated list of active products under the category |
| `POST` | `/api/catalog/media` | `{ ownerType, ownerId, uri, type, altText? }` | bearer + `catalog:write` | new MediaAsset |
| `PATCH` | `/api/catalog/media/reorder` | `{ ownerType, ownerId, mediaIdsInOrder: number[] }` | bearer + `catalog:write` | updated list |
| `DELETE` | `/api/catalog/media/:id` | — | bearer + `catalog:write` | archived MediaAsset |
| `GET` | `/api/catalog/products/:productId/media` | — | `@Public()` | sorted active MediaAssets |
| `GET` | `/api/catalog/variants/:variantId/media` | — | `@Public()` | sorted active MediaAssets |

**Kulala HTTP files** (under `http/`):

- **`http/catalog-categories.http`** — NEW; covers category CRUD + product-category attach + browse.
- **`http/catalog-media.http`** — NEW; covers media create/reorder/archive + browse.

## Test Strategy

**Unit tests:**

- `apps/catalog-microservice/src/modules/catalog/domain/spec/category.model.spec.ts` — `slug` kebab-case invariant; cycles forbidden (cannot reparent A under one of A's descendants); `path` regeneration semantics.
- `apps/catalog-microservice/src/modules/catalog/domain/spec/media-asset.model.spec.ts` — `uri` non-empty; `ownerType` enum; `sortOrder` non-negative.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/create-category.use-case.spec.ts` — slug duplication rejected; root vs child paths correct.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/reparent-category.use-case.spec.ts` — descendants' paths recomputed in the same transaction; cycle rejected; root demotion path.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/reclassify-product.use-case.spec.ts` — attach/detach is idempotent; unknown category rejected.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/attach-media.use-case.spec.ts` — sortOrder default = max+1; per-owner ordering preserved.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/reorder-media.use-case.spec.ts` — bulk reorder is atomic.

**E2E tests:**

- `test/catalog-categories.e2e-spec.ts`:
  1. Admin creates a root + two children + one grandchild; `path` values match expectation.
  2. Reparenting one of the grandchildren under a different root recomputes the path; subtree paths verified.
  3. Reclassifying a seeded product into two categories returns it under both browse endpoints.
  4. Cycle reparent rejected (`409`).
- `test/catalog-media.e2e-spec.ts`:
  1. Admin attaches three media to a product, in given order.
  2. Reorder them.
  3. Detach one; browse returns the other two in the post-detach order.

**Concurrency tests:** N/A.

**Seed data required:**

- Three seeded categories (`/electronics`, `/electronics/phones`, `/apparel`); one of the two seeded products attached to two of them.
- Two seeded media (one image, one video) on one of the seeded products.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/epic-06-catalog-category-and-media/`:

- `01-category-hierarchy-and-materialized-path.md` — why a materialized `path` over closure-table; how reparent is implemented; cycle detection.
- `02-product-categories-join.md` — N↔M relationship rationale; idempotent attach.
- `03-media-asset-polymorphism.md` — `ownerType` discriminator; opaque-URI policy (no upload pipeline); sortOrder semantics.
- `04-publish-precondition-media-soft-warning.md` — the "≥1 MediaAsset recommended" note; how it surfaces in the publish response without blocking.
- `05-category-and-media-api.md` — endpoint shapes; the `includeDescendants` query knob.
- `06-kulala-files.md` — `http/catalog-categories.http` and `http/catalog-media.http`.

**`README.md` updates required:**

- Extend **API → Catalog** with the new category + media endpoints.
- Add a small **Catalog navigation** paragraph noting the materialized path approach.

**`CLAUDE.md` updates required:**

- Extend the **Catalog microservice** section's file-listing snippet to include category + media-asset entities + use cases.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Add Category entity + persistence + mapper.** Migration creates `category` + `product_categories`. Domain spec for cycle detection.
2. **Implement Create Category + Reparent Category use cases.** Materialized-path recomputation across the subtree in one transaction.
3. **Implement Reclassify Product + Browse-by-Category use cases.**
4. **Add MediaAsset entity + persistence + use cases.** Attach / Reorder / Detach / browse.
5. **Lift the publish-product media precondition** to a soft warning in the response shape (from `epic-02`'s post-publish DTO).
6. **Add api-gateway controllers + DTOs** for the new endpoints.
7. **Author `http/catalog-categories.http` + `http/catalog-media.http`.**
8. **Seed + docs pass.**

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-02` complete; catalog microservice operational. | `category.entity.ts`, mapper, repository methods; migration; spec; `01-…md`. |
| 2 | Task 1 complete. | Two use cases + specs; `01-…md` complete. |
| 3 | Tasks 1–2 complete. | Reclassify + browse use cases + specs; `02-…md`. |
| 4 | Tasks 1–3 complete. | `media-asset.entity.ts`, mapper, repository methods; four use cases + specs; migration; `03-…md`. |
| 5 | Tasks 1–4 complete. | Updated `publish-product.use-case.ts` DTO; updated spec; `04-…md`. |
| 6 | Tasks 1–5 complete. | api-gateway controllers + DTOs + pipes. |
| 7 | Task 6 complete. | New `http/catalog-categories.http` + `http/catalog-media.http`; `06-…md`. |
| 8 | All prior tasks complete. | Extended seed; README + CLAUDE.md updates. |

## Exit Criteria

- [ ] `yarn lint` passes; `yarn test:unit` passes (≥7 new specs); `yarn test:e2e` passes (two new e2e files green).
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean; new tables present.
- [ ] Every request in the new HTTP files executes; seeded categories are browseable; seeded media is returned in order.
- [ ] Reparenting a category recomputes descendant paths in one transaction (verified by e2e + DB inspection).
- [ ] Per-task docs present under `docs/implementation/epic-06-catalog-category-and-media/`.
- [ ] `README.md` and `CLAUDE.md` reflect the new endpoints + file shapes.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
