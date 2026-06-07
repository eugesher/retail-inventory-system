---
epic: epic-04
task_number: 6
title: Docs + README/CLAUDE + lint-fixtures finalization
depends_on: [1, 2, 3, 4, 5]
doc_deliverable: docs/implementation/04-inventory-stock-level-and-location/08-inventory-http-file.md
adr_deliverable: none
---

# Task 06 — Docs + README/CLAUDE + lint-fixtures finalization

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-017** (architecture lint via `eslint-plugin-boundaries`; the
`spec/architecture-lint.spec.ts` regression suite mirrors `eslint.config.mjs` —
don't weaken either), **ADR-003** (ADR conventions, in case ADR-027's status/links
need a final check), and **execution-requirements.md §5/§6** (README + CLAUDE are
part of the deliverable; the self-containment grep is the finishing gate).

## Goal

Close the inventory capability: write the last implementation doc (the
`http/inventory.http` walkthrough), bring `README.md` and `CLAUDE.md` fully in
line with the new model, re-verify (and lightly extend) the architecture-lint
fixtures for the inventory `stock` module, and run the final self-containment grep
across the whole tree. No production code behaviour changes here — this is the
documentation + guardrail pass.

## Entry state assumed

- task-01 → task-05 carryovers present. The full inventory capability is live:
  `stock_location` + `stock_level` (with `version`) + `default-warehouse`; the
  `StockLocation` / `StockLevel` models; cache `v2` keyed on `variantId`; the
  read RPCs + gateway read endpoints; the auto-init consumer (catalog publisher
  retargeted to `inventory_queue`); Receive/Adjust write ops + events + low-stock;
  `http/inventory.http` (read + write); the stock-level seed; ADR-027 (ADR-012
  superseded). Docs `01`–`07` are written.
- `README.md` still describes the inventory system around `product_stock` /
  `storage` and the old `GET /api/product/:productId/stock` route + the
  `ris:inventory:stock:v1:<productId>:…` cache key (except the minimal dropped-route
  edit task-01 made). `CLAUDE.md`'s stock-module file listing, message-pattern
  list, and cache-version notes still describe the old model (again except task-01's
  minimal edit).
- `spec/architecture-lint.spec.ts` has a `describe(... 'inventory'/'stock' ...)`
  block with the existing fixtures; `eslint.config.mjs` classifies
  `apps/inventory-microservice/src/modules/stock/**` by the generic element
  patterns — the new `infrastructure/consumers/` folder is already covered as an
  `infrastructure` layer.

## Scope

**In**
- Write `08-inventory-http-file.md`.
- Full `README.md` pass (system diagram, API → Stock, Caching key shape, Database
  note on `default-warehouse`).
- Full `CLAUDE.md` pass (stock-module file listing, message-pattern list, cache
  notes, operational-notes cache bullet).
- Re-verify the inventory architecture-lint fixtures; add a fixture locking the
  new `consumers/` boundary if it strengthens coverage.
- Final self-containment grep across the whole tree; remove any pre-existing leak.

**Out**
- Any production code/schema/test behaviour change. If finalization surfaces a
  genuine bug, fix it minimally and note it in the carryover — but the intent here
  is docs + guardrails.

## README.md updates

- **System diagram** — replace the inventory `product_stock` / `storage` boxes
  with `stock_location` + `stock_level`; the legacy inventory `product` box is
  already gone.
- **API → Stock** — replace the old `GET /api/product/:productId/stock` entry with
  the four inventory routes:
  `GET /api/inventory/locations` (staff, `inventory:read`),
  `GET /api/inventory/variants/:variantId/stock` (public),
  `POST /api/inventory/variants/:variantId/stock/receive` (staff, `inventory:adjust`),
  `POST /api/inventory/variants/:variantId/stock/adjust` (staff, `inventory:adjust`).
- **Caching → Cache key** — show the new shape
  `ris:inventory:stock:v2:<variantId>:<facet>` and note the `v1 → v2` bump and the
  `productId → variantId` key axis.
- **Caching → Inspecting the cache** — update the snippet to use `variantId` + the
  new prefix (e.g. `redis-cli --scan 'ris:inventory:stock:v2:*'`).
- **Database** — a brief note that the migration auto-provisions a single
  `default-warehouse` `StockLocation`; the stock-level seed loads 100 on hand per
  seeded variant there.
- Update the environment/seed tables if a cache-TTL env was renamed in task-02
  (check `carryover-02.md`).

## CLAUDE.md updates

- **Architecture → inventory `stock` module** — replace the entity/file listing
  with `stock-location.entity.ts`, `stock-level.entity.ts` (+ mappers), the
  `StockLocation`/`StockLevel` models, the `query-availability` / `list-locations` /
  `receive-stock` / `adjust-stock` / `auto-init-stock-level` use cases, the
  `infrastructure/consumers/catalog-events.consumer.ts`, and the rebuilt gateway
  `modules/inventory/` routes. Note the keep-but-deprecated confirm stub.
- **Message patterns → Inventory** — remove `inventory.product-stock.get`; add
  `inventory.stock-level.get`, `inventory.location.list`,
  `inventory.stock-level.receive`, `inventory.stock-level.adjust`,
  `inventory.stock.received`, `inventory.stock.adjusted`,
  `inventory.stock-level.initialized`; mark `inventory.order.confirm` as a
  deprecation stub reshaped by the inventory-reservation capability; note
  `catalog.variant.created` is now consumed by inventory (delivered on
  `inventory_queue`); keep `inventory.stock.low` (payload reshaped to
  `variantId`/`stockLocationId`).
- **Shared Libraries → cache** — note `INVENTORY_STOCK_KEY_VERSION = 'v2'` and the
  added legacy prefix builder.
- **Operational notes** — update the cache-aside bullet to the new `v2`/`variantId`
  key; update the "Cross-service events" bullet to record that
  `catalog.variant.created → inventory` is now wired (auto-init), and that
  `inventory.stock.{received,adjusted,initialized}` are reserved surfaces.
- **Architecture decisions** — bump the "next free number" note to `028` and add
  ADR-027 to the list; reflect that ADR-012 is superseded.

Describe everything by capability — no "epic"/"task" wording anywhere.

## Architecture-lint fixtures

In `spec/architecture-lint.spec.ts`, re-run/confirm the inventory `stock` module
fixtures still pass against the new file set. Optionally add a fixture asserting an
`infrastructure/consumers/` file may not import another module's domain or a
forbidden transport beyond the allowed Nest microservices imports (mirror the
existing infrastructure-layer fixtures). Keep the inlined `ELEMENTS` /
`DEPENDENCY_RULES` mirrored with `eslint.config.mjs` — do **not** weaken either
(ADR-017). No new module is introduced, so no `eslint.config.mjs` change is
expected; if you find one is needed, that is a signal to re-examine, not to relax a
rule.

## Files to add

- `docs/implementation/04-inventory-stock-level-and-location/08-inventory-http-file.md`

## Files to modify

- `README.md` (system diagram, API → Stock, Caching, Database).
- `CLAUDE.md` (stock-module listing, message-pattern list, cache notes,
  operational notes, ADR list + next-free-number).
- `spec/architecture-lint.spec.ts` (re-verify; optional consumer fixture).

## Files to delete

None.

## Tests

- `yarn test:unit` — `spec/architecture-lint.spec.ts` is green (and any added
  fixture asserts its rule fires).
- `yarn test:e2e` — unchanged behaviour; the full suite stays green.
- No new production specs in this task.

## Doc deliverable

`08-inventory-http-file.md` — the `http/inventory.http` walkthrough: the four
endpoints it covers; the `# Prereqs:` staff-login flow that captures `@accessToken`
for the protected calls; the `?locationIds` encoding + the omit-to-aggregate
(read) / omit-targets-`default-warehouse` (write) conventions; that it replaced
the deleted `http/product.http`. Cross-link `07-availability-read-path.md` and
`06-receive-and-adjust-use-cases.md`.

## Carryover to read

`carryover-01.md` … `carryover-05.md`.

## Carryover to produce

Write `carryover-06.md` — the closing note for the capability. Capture: that
`README.md` + `CLAUDE.md` are fully aligned; the final architecture-lint state;
the result of the whole-tree self-containment grep; and a one-paragraph summary of
the delivered inventory capability with the explicit deferrals (reservation,
allocation, `StockMovement`, transfer, concurrent-oversell enforcement) named for
the later capabilities that own them. List the final full verify sequence
(`yarn lint`, `yarn test:unit`, `yarn test:e2e`,
`docker compose up -d && yarn migration:run && yarn start:dev && yarn test:seed`,
the `http/inventory.http` run, the Redis `--scan` check, and the grep).

## Exit criteria

- [ ] `08-inventory-http-file.md` is written; docs `01`–`08` are all present.
- [ ] `README.md` System diagram + API + Caching + Database sections reflect the
      new model, routes, and `v2`/`variantId` cache key.
- [ ] `CLAUDE.md` stock-module listing, message-pattern list, cache notes,
      operational notes, and ADR list are updated; ADR-012 shown superseded by
      ADR-027; next-free-ADR note advanced.
- [ ] The inventory architecture-lint fixtures pass; no `eslint.config.mjs` rule
      was weakened.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `yarn test:e2e` passes.
- [ ] The final self-containment grep is clean across the whole tree
      (`grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`).
- [ ] All of the epic's cumulative exit criteria (see the task index `README.md`)
      are satisfied.
- [ ] `carryover-06.md` is written.
