---
epic: epic-02
task_number: 10
title: Seed, docs, and lint-fixtures finalization
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06, task-07, task-08, task-09]
doc_deliverable: none
adr_deliverable: none
---

# Task 10 — Seed, docs, and lint-fixtures finalization

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

Most relevant ADRs: **ADR-017** (architecture-lint regression fixtures in
`spec/architecture-lint.spec.ts`), **ADR-019** (seeds), **ADR-018 / ADR-004 /
ADR-008 / ADR-025** (the facts README + CLAUDE.md must now reflect).

## Goal

Close the work: seed the standing catalog products/variants so other capabilities
can address them by id, extend the architecture-lint regression suite to cover
the catalog microservice's boundaries, bring `README.md` and `CLAUDE.md` fully
into line with the new service, and run the final self-containment gate across the
whole repository.

## Entry state assumed

- task-01–09 carryover present. The catalog microservice + gateway module +
  `http/catalog.http` are complete and green. Per-topic docs `01`–`08` exist
  under `docs/implementation/02-catalog-product-and-variant/`. ADR-025 is committed.
- The baseline seed (`scripts/test-db-seed.ts`) **already** seeds the
  `catalog:read|write|publish` permissions and the `catalog-manager` role —
  **do not re-add them**. `TestDbSeedUtil.seedFiles` (after the cleanup) is
  `['product-stock.sql', 'order.sql', 'order-product.sql']`.
- `spec/architecture-lint.spec.ts` is hermetic: it inlines its own `ELEMENTS` +
  `DEPENDENCY_RULES` (generic `apps/*/src/modules/*/...` patterns) and points
  virtual fixtures at **real** production paths. It has fixtures for the
  inventory `stock` module and the gateway `auth`/`iam` modules, none for catalog.

## Scope

**In**

- New catalog seed SQL + `seedFiles` registration (idempotent).
- New catalog boundary fixtures in `spec/architecture-lint.spec.ts`.
- `README.md` + `CLAUDE.md` updates.
- The final repo-wide self-containment grep + fixing any leak found.

**Out**

- Re-seeding permissions/roles (already seeded by the baseline).
- Any production behaviour change.

## Catalog seed (standing data)

Add two seed files (model on the existing `scripts/seeds/*.sql` — `INSERT IGNORE`
with explicit stable ids so re-running is idempotent), and register them in
`scripts/utils/test-db-seed.util.ts` **after** the existing entries, with the
parent before the child (FK `product_variant.product_id → product.id`):

- `scripts/seeds/catalog-product.sql` — two products in `active` status, e.g.:

  ```sql
  INSERT IGNORE INTO product (id, name, slug, description, status)
  VALUES (1, 'Aurora Desk Lamp', 'aurora-desk-lamp', 'A warm LED desk lamp', 'active'),
         (2, 'Nimbus Office Chair', 'nimbus-office-chair', 'An ergonomic mesh chair', 'active');
  ```

- `scripts/seeds/catalog-product-variant.sql` — two variants per product, all
  `active`, distinct `sku`s, valid JSON `option_values`, e.g.:

  ```sql
  INSERT IGNORE INTO product_variant (id, product_id, sku, gtin, option_values, weight_g, dimensions_mm, status)
  VALUES (1, 1, 'AURORA-WARM', NULL, '{"color":"warm-white"}', 800, '{"l":300,"w":120,"h":120}', 'active'),
         (2, 1, 'AURORA-COOL', NULL, '{"color":"cool-white"}', 800, '{"l":300,"w":120,"h":120}', 'active'),
         (3, 2, 'NIMBUS-BLACK', NULL, '{"color":"black"}', 12000, '{"l":650,"w":650,"h":1100}', 'active'),
         (4, 2, 'NIMBUS-GREY',  NULL, '{"color":"grey"}',  12000, '{"l":650,"w":650,"h":1100}', 'active');
  ```

  Final `seedFiles` order: `['product-stock.sql', 'order.sql', 'order-product.sql', 'catalog-product.sql', 'catalog-product-variant.sql']`.
  (The seed util splits on `;` and strips `--` comments — keep statements simple.)

## Architecture-lint fixtures (`spec/architecture-lint.spec.ts`)

Add a `describe('boundaries/dependencies — catalog microservice', …)` block that
mirrors the existing inventory/gateway bumpers, with virtual fixtures pointed at
real catalog paths (the generic `apps/*` patterns classify them automatically —
no `ELEMENTS`/rules change). At minimum:

- catalog `domain` may not import `@nestjs/common` → fixture at
  `apps/catalog-microservice/src/modules/catalog/domain/__fixture__.ts`.
- catalog `domain` may not import `typeorm` (same path).
- catalog `application/use-cases` may not import `typeorm` / `@nestjs/typeorm`
  → fixture at `…/application/use-cases/__fixture__.ts`.
- catalog `application/ports` may not import `typeorm` → `…/application/ports/__fixture__.ts`.
- catalog `presentation` may not import `@retail-inventory-system/database`
  (or `typeorm`) → `…/presentation/__fixture__.ts`.

Each asserts `ruleIds(messages)` contains `boundaries/dependencies`. (These are
regression bumpers — they prove a future refactor can't silently exempt the
catalog tree.)

## README.md updates

- **Services table** — add a `catalog-microservice` row (port: none/RMQ-only;
  queue `catalog_queue`; owns Product + ProductVariant).
- **System diagram** — add the catalog box + `catalog_queue` and show the new
  routing keys (`catalog.product.published/archived`, `catalog.variant.created`,
  and the RPC keys). **Remove** the inventory-microservice `product` box/table
  and any prose describing it (it was dropped) — leave `product_stock` /
  `order_product` with their now-FK-free `product_id` columns described correctly.
- **API → Catalog** — add the seven-endpoint list with auth notes.
- Add a diagram caption noting that **every downstream cluster keys on
  `variantId`** (inventory stock, pricing, order/cart lines), not `productId`.

## CLAUDE.md updates

- **Architecture app tree** — add `apps/catalog-microservice/`.
- New section **Catalog microservice (`apps/catalog-microservice/src/`)**
  mirroring the notification/inventory/retail per-module template block (domain /
  application / infrastructure / presentation, the ports + symbols, the publisher
  + client module, the controller's RPC patterns).
- **Message patterns** list — add the catalog RPC + event keys with one-line
  descriptions (who produces, who consumes / "no consumer yet").
- **Shared Libraries → messaging** — mention `MicroserviceClientCatalogModule`.
- Update the **RabbitMQ queues** line to include `catalog_queue`.
- Do not use the words "epic"/"task" anywhere; describe forward work
  (inventory keying on `variantId`, pricing) by capability.

## Files to add

- `scripts/seeds/catalog-product.sql`
- `scripts/seeds/catalog-product-variant.sql`

## Files to modify

- `scripts/utils/test-db-seed.util.ts` (register the two seed files, in order)
- `spec/architecture-lint.spec.ts` (catalog fixtures)
- `README.md`
- `CLAUDE.md`

## Files to delete

- None.

## Tests

- `yarn test:unit` — the extended `architecture-lint.spec.ts` is green (the new
  catalog bumpers fire as expected).
- `yarn test:e2e` on a fresh `yarn test:infra:reload` — the seed loads
  idempotently (run the seed twice; no error, no duplicate rows) and
  `GET /api/catalog/products` returns the two seeded active products with their
  variants.
- Re-run `http/catalog.http` end-to-end against the seeded stack.

## Doc deliverable

None new under `docs/implementation/02-catalog-product-and-variant/` (docs `01`–`08`
were written by their owning tasks). This task updates `README.md` + `CLAUDE.md`
and extends `spec/architecture-lint.spec.ts`. Verify `01`–`08` are all present
and self-contained.

## Carryover to read

`carryover-01.md` … `carryover-09.md`.

## Carryover to produce

Write `carryover-10.md` capturing: the standing seed (ids 1–2 products, 1–4
variants) + final `seedFiles` order; the catalog architecture-lint fixtures
added; the README/CLAUDE sections updated; the result of the final
self-containment grep (must be clean); the full verification command set proving
every cumulative exit criterion.

## Exit criteria

- [ ] `scripts/seeds/catalog-product.sql` + `scripts/seeds/catalog-product-variant.sql`
      exist, are registered in `seedFiles` (parent before child), and are
      idempotent (re-running `yarn test:seed` does not error or duplicate).
- [ ] `GET /api/catalog/products` returns the two seeded active products with
      their variants.
- [ ] `spec/architecture-lint.spec.ts` has catalog boundary fixtures and is green.
- [ ] `README.md` Services table + System diagram (catalog added, inventory
      `product` box removed) + API→Catalog section + `variantId` caption are done.
- [ ] `CLAUDE.md` has the app-tree entry, the Catalog microservice section, the
      catalog message patterns, the `catalog_queue` mention, and the
      `MicroserviceClientCatalogModule` note.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots all
      five services; `catalog_queue` is bound on RabbitMQ.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` passes
      (≥6 new catalog domain/use-case specs green across the prior tasks);
      `yarn test:e2e` passes (`test/catalog.e2e-spec.ts` green).
- [ ] The final self-containment grep is clean across the whole repo:
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`
      (investigate every hit; remove any planning-process reference, including
      pre-existing leaks encountered).
- [ ] `carryover-10.md` is written.
