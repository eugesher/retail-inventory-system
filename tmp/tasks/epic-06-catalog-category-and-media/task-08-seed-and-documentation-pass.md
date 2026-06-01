---
epic: epic-06
task_number: 8
title: Seed + documentation pass — extend test seed, README API + navigation, CLAUDE.md catalog listing
depends_on: [epic-02, task-01, task-02, task-03, task-04, task-05, task-06, task-07]
doc_deliverable_primary: —
---

# Task 08 — Seed + documentation pass

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs only as needed (mostly a docs/seed task):
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — test seeds are applied after migrations; idempotency.
  - [ADR-016](../../../docs/adr/016-cache-aside-generalized.md) / [ADR-022](../../../docs/adr/022-cache-keys-tenant-and-schema-version.md) — the category cache-key builders the CLAUDE.md note references (builders added, not used this epic).

## Goal

Close out the epic. Extend `scripts/test-db-seed.ts` with the category/media fixtures the e2e + HTTP files address, bring `README.md` and `CLAUDE.md` in sync with the new endpoints + entities, and flip any `xit` / disabled blocks that tasks 06–07 parked pending the seed.

This is a cumulative pass — every prior task produced its own artifacts (entities, migrations, use cases, controllers, docs); this task assembles the "outside" view and the seeded fixtures.

## Entry state assumed

`epic-02` merged; tasks 01–07 carryover present:

- `category`, `product_categories`, `media_asset` tables exist; the catalog-microservice exposes the new `@MessagePattern` handlers; the gateway exposes the 11 endpoints; both `.http` files exist.
- `scripts/test-db-seed.ts` already seeds the `epic-02` catalog fixtures (two products with variants) + the `epic-01` identity fixtures, and (per `epic-02` task-09) a `catalog-manager` StaffUser bound to `catalog:read/write/publish` and a non-catalog `warehouse-staff` StaffUser. **Confirm this** against the actual seed; if the `catalog-manager` user is absent, add it here (it is the positive fixture for the write e2e blocks).
- `test/catalog-categories.e2e-spec.ts` / `test/catalog-media.e2e-spec.ts` may have `xit`-marked permission blocks with `TODO(task-08)` comments.

## Scope

**In:**

- Extend `scripts/test-db-seed.ts` (idempotent — re-running `yarn test:seed` is a no-op, no duplicate rows):
  - Three categories: `/electronics` (root), `/electronics/phones` (child of electronics), `/apparel` (root). Set `path`, `parentId`, `status='active'`, `sortOrder`.
  - Attach **one** of the two seeded `epic-02` products to **two** of these categories (e.g. product 1 → `/electronics` and `/electronics/phones`) via `product_categories`.
  - Two media assets on one seeded product: one `image`, one `video` (`ownerType='product'`, `sortOrder` 0 and 1, `status='active'`, opaque `https://…` URIs).
  - If `catalog-manager` / `warehouse-staff` StaffUsers are not already seeded by `epic-02`, add them here (positive + negative permission fixtures).
- Update `README.md`:
  - Extend the **API → Catalog** section with the 11 category + media endpoints (mirror the existing endpoint-table shape: Method, Path, Auth, Notes). Notes call out `catalog:write` vs `@Public()` and the `includeDescendants` knob.
  - Add a short **Catalog navigation** paragraph: categories form a self-hierarchical tree with a materialized `path`; browse-by-category is a path-prefix scan; reparent recomputes descendant paths in one transaction; media is polymorphic over product/variant.
- Update `CLAUDE.md`:
  - Extend the **Catalog microservice** file-listing snippet (added by `epic-02`) to include the category + media-asset entities, the `Category`/`MediaAsset` domain models, the new use cases (`create-category`, `reparent-category`, `reclassify-product`, `browse-by-category`, `attach-media`, `reorder-media`, `detach-media`, `browse-media-by-owner`), and the new `@MessagePattern` handlers / routing keys.
  - Note that category/media edits emit **no** domain events and invoke **no** `AUDIT_LOG_PUBLISHER` (the deliberate decisions from the epic), and that the publish response now carries `warnings: string[]`.
- Flip task-06's `xit` permission blocks → `it` and remove `TODO(task-08)` comments now that the seed supports them.
- Flip any `### DISABLED` markers task-07 left in the `.http` files → active `###`.

**Out:**

- Any change to catalog domain / use-case / controller code — locked by tasks 01–06.
- Any new endpoint, routing key, or migration — locked by tasks 01–06.
- The Exclusions Register (`epic-15`) — this epic owns none.
- New ADRs — this epic introduces no new architectural decision (it honors existing ADRs); do **not** write an ADR.

## Files to add

- (none new; polish pass)

## Files to modify

- `scripts/test-db-seed.ts` — categories, `product_categories` rows, media assets, (and the two StaffUsers if absent); all idempotent.
- `README.md` — API → Catalog endpoint additions + Catalog-navigation paragraph.
- `CLAUDE.md` — catalog file-listing + the no-event / no-audit / `warnings` notes.
- `test/catalog-categories.e2e-spec.ts`, `test/catalog-media.e2e-spec.ts` — flip `xit` → `it`, remove `TODO(task-08)`.
- `http/catalog-categories.http`, `http/catalog-media.http` — flip any disabled markers (only if task-07 added them).

## Files to delete

None.

## Tests

- `yarn test:unit` — no new specs; all existing green.
- `yarn test:e2e` — full green:
  - `catalog-categories.e2e-spec.ts`: create tree → reparent → reclassify → browse → cycle `409`; permission gates (`catalog-manager` can write, `warehouse-staff` gets `403`, unauthenticated GETs `200`).
  - `catalog-media.e2e-spec.ts`: attach three → reorder → detach → browse remaining two; permission gates.
  - `epic-01` + `epic-02` e2es still pass — the seed extension is additive.
- `yarn test:seed` is idempotent — running twice produces no errors, no duplicate rows, the same seeded categories/memberships/media.

## Doc deliverable

None new. The six per-task docs (`01`–`06`) were written by tasks 01–07; this task verifies each exists and is complete (no stray placeholders), and updates the top-level `README.md` + `CLAUDE.md`.

## Carryover produced

- The seeded DB carries 3 categories, one product in 2 categories, 2 media on a product, plus the catalog-manager/warehouse-staff fixtures.
- `README.md` + `CLAUDE.md` reflect the new endpoints + entities + decisions.
- The two e2e suites run all blocks without `xit`; both `.http` files run all blocks.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; ≥7 new specs (across tasks 01–05) are green.
- [ ] `yarn test:e2e` passes; both new e2e files run all blocks; `epic-01`/`epic-02` e2es still pass.
- [ ] `yarn test:seed` is idempotent (run twice → no errors, no duplicates).
- [ ] `docker compose up -d && yarn migration:run && yarn test:seed && yarn start:dev` boots clean; the new tables are populated; seeded categories are browseable; seeded media returns in order.
- [ ] All six per-task docs under `docs/implementation/06-catalog-category-and-media/` exist and are complete.
- [ ] `README.md` (API → Catalog + Catalog-navigation paragraph) and `CLAUDE.md` (catalog file-listing) reflect the epic.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.
