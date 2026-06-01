---
epic: epic-06
source_epic_file: tmp/epics/epic-06-catalog-category-and-media.md
---

# Epic 06 — Task Index

Decomposition of `tmp/epics/epic-06-catalog-category-and-media.md` into 8 sequential, self-contained execution tasks. Each task file states its entry-state assumption (what previous tasks — and `epic-02` — leave on disk), the concrete files to add/modify/delete, the doc deliverable, and the exit criteria. The decomposition mirrors the layout used for `epic-02` and `epic-04`.

This epic **extends the existing `catalog` module** introduced by `epic-02` — it adds no new bounded context, no new microservice, no new domain events, no new routing keys *to the bus*, and no `AUDIT_LOG_PUBLISHER` calls. (The two new RPC routing keys it adds are gateway↔catalog request/response patterns, not fan-out events — see task-03/04.) That keeps `eslint-plugin-boundaries` (ADR-017) untouched and concentrates the difficulty in domain logic (materialized-path recompute + cycle detection) and polymorphic ownership rather than infrastructure wiring.

## Sequence and dependencies

Tasks depend on each other through the `Carryover Between Tasks` table in the epic. Do them in order; do not parallelize. Task-01 lands the `Category` aggregate + its persistence + the `product_categories` join; task-02 adds the two category write use cases (the materialized-path recompute is the hard part); task-03 adds product↔category reclassify + browse; task-04 adds the polymorphic `MediaAsset` end-to-end; task-05 lifts `epic-02`'s publish precondition to a soft warning; task-06 wires the api-gateway HTTP surface; task-07 backfills the Kulala HTTP files; task-08 closes out with seeds, README, and CLAUDE.md.

| #   | Task                                                                                                                       | Touches                                                                                                                                                                                                | Doc deliverable                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 01  | [Add `Category` domain + persistence + `product_categories` join](task-01-category-domain-persistence-and-join.md)         | `apps/catalog-microservice/src/modules/catalog/domain/`, `…/infrastructure/persistence/`, `…/application/ports/`, migration `CreateCategoryAndProductCategoriesTables`                                   | `01-…` (partial)                                                 |
| 02  | [Implement `Create Category` + `Reparent Category` use cases](task-02-create-and-reparent-category-use-cases.md)           | `…/application/use-cases/{create-category,reparent-category}.use-case.ts` + specs; `…/presentation/catalog.controller.ts` `@MessagePattern` handlers; RPC routing keys                                   | `01-…` (complete)                                                |
| 03  | [Implement `Reclassify Product` + `Browse by Category` use cases](task-03-reclassify-product-and-browse-use-cases.md)      | `…/application/use-cases/{reclassify-product,browse-by-category}.use-case.ts` + specs; `@MessagePattern` handlers; RPC routing keys                                                                      | `02-product-categories-join.md`                                  |
| 04  | [Add `MediaAsset` domain + persistence + use cases](task-04-media-asset-domain-persistence-and-use-cases.md)               | `…/domain/media-asset.model.ts`, persistence, mapper, repo; four use cases (attach/reorder/detach/browse) + specs; migration `CreateMediaAssetTable`; `@MessagePattern` handlers                          | `03-media-asset-polymorphism.md`                                 |
| 05  | [Lift the publish-product media precondition to a soft warning](task-05-publish-media-soft-warning.md)                     | `…/application/use-cases/publish-product.use-case.ts` (from `epic-02`) + its post-publish DTO + spec; `libs/contracts/catalog/`                                                                          | `04-publish-precondition-media-soft-warning.md`                  |
| 06  | [Add api-gateway controllers + DTOs for category + media](task-06-api-gateway-category-and-media-endpoints.md)             | `apps/api-gateway/src/modules/catalog/` (extend port + adapter + use cases + controller(s) + DTOs + pipes); `test/catalog-categories.e2e-spec.ts`, `test/catalog-media.e2e-spec.ts`                       | `05-category-and-media-api.md`                                   |
| 07  | [Author `http/catalog-categories.http` + `http/catalog-media.http`](task-07-kulala-http-files.md)                          | `http/catalog-categories.http`, `http/catalog-media.http`                                                                                                                                               | `06-kulala-files.md`                                             |
| 08  | [Seed + documentation pass — seed, README, CLAUDE.md](task-08-seed-and-documentation-pass.md)                              | `scripts/test-db-seed.ts`, `README.md`, `CLAUDE.md`                                                                                                                                                     | —                                                                |

## Document-deliverable map

The epic lists six topic-numbered docs under `docs/implementation/06-catalog-category-and-media/`. A doc can be touched by more than one task:

- **`01-category-hierarchy-and-materialized-path.md`** — task-01 writes the persistence + cycle-detection half (why materialized `path` over closure-table; self-FK `ON DELETE SET NULL`). Task-02 completes it with the reparent-recompute algorithm and cycle-rejection at the use-case layer.
- **`02-product-categories-join.md`** — task-03 (N↔M rationale; idempotent attach/detach; why no event is emitted).
- **`03-media-asset-polymorphism.md`** — task-04 (`ownerType` discriminator; opaque-URI policy; `sortOrder` semantics).
- **`04-publish-precondition-media-soft-warning.md`** — task-05 (the "≥1 active MediaAsset recommended" note; how it surfaces non-blocking in the publish response).
- **`05-category-and-media-api.md`** — task-06 (endpoint shapes; the `includeDescendants` query knob).
- **`06-kulala-files.md`** — task-07.

## Cross-epic coupling notes

- **`epic-02`** is a hard prerequisite. The `catalog-microservice`, the `catalog` module (`Product`/`ProductVariant` aggregates, `Slug` VO, `CatalogDomainError` base, the repository module, the `@MessagePattern` controller), the api-gateway `modules/catalog/`, and the `catalog:write`/`catalog:read`/`catalog:publish` permission codes all come from `epic-02`. Every task below assumes `epic-02` is merged. Task-01 reuses `epic-02`'s `Slug` VO and `CatalogDomainError` base rather than re-introducing them.
- **`epic-01`** supplies the gateway RBAC primitives the task-06 controllers gate on (`PermissionsGuard`, `@RequiresPermission()`, `@Public()`, `PermissionCodeEnum.CATALOG_WRITE`).
- **No downstream epic depends on this one's outputs** — category/media are read-side merchandising concerns; the report keeps them out of the must-emit event set, so no consumer waits on them.

## Self-containment rule

> Outputs produced by these tasks must not reference any path under `tmp/`. The task files themselves live in `tmp/tasks/…` and are scaffolding; the artifacts they produce (entities, migrations, docs, controllers, http files, README/CLAUDE updates) live under `apps/`, `libs/`, `migrations/`, `http/`, `docs/`, `scripts/`, `README.md`, `CLAUDE.md` — and none of those files may cite `tmp/`.

## Exit criteria (all 8 tasks complete)

Mirrors the epic's `Exit Criteria`. Each task carries its own per-task exit criteria; this is the cumulative gate.

- [ ] `yarn lint` passes (`--max-warnings 0`); no boundaries-rule changes were needed (the catalog module already exists).
- [ ] `yarn test:unit` passes; ≥7 new domain/use-case spec files green under `apps/catalog-microservice/`.
- [ ] `yarn test:e2e` passes; `test/catalog-categories.e2e-spec.ts` and `test/catalog-media.e2e-spec.ts` are green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean; the new `category`, `product_categories`, and `media_asset` tables are present.
- [ ] Every request in `http/catalog-categories.http` and `http/catalog-media.http` executes; seeded categories are browseable; seeded media is returned in order.
- [ ] Reparenting a category recomputes descendant paths in one transaction (verified by e2e + DB inspection).
- [ ] Per-task docs present under `docs/implementation/06-catalog-category-and-media/`.
- [ ] `README.md` (API → Catalog + a Catalog-navigation paragraph) and `CLAUDE.md` (catalog file-listing) reflect the new endpoints + entities.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.
