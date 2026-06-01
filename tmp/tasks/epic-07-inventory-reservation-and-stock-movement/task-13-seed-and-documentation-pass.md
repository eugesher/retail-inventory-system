---
epic: epic-07
task_number: 13
title: Seed + documentation pass — env, seed, README, CLAUDE.md, arch-lint
depends_on: [01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12]
doc_deliverable: (closes out — reconciles all ten docs; no new topic-numbered file)
---

# Task 13 — Seed + documentation pass

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-017](../../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) — the arch-lint fixture suite; this task adds the append-only-`stock_movement` assertion.
  - [ADR-022](../../../docs/adr/022-cache-keys-tenant-and-schema-version.md) — the CLAUDE.md cache-note update to `v3`.
  - [ADR-010](../../../docs/adr/010-jwt-rbac-at-the-gateway.md) — the `inventory:transfer` permission seeded into `warehouse-staff`.
  - [ADR-014](../../../docs/adr/014-otel-exporter-otlp-http-and-jaeger.md) / [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — env-var conventions (Joi fail-fast) for `RESERVATION_TTL_MINUTES`.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — any seed/script logging uses `PinoLogger`, never `@nestjs/common` `Logger`.

## Goal

Close the epic: wire the new env var into the example files, seed the new permission + the fixtures the e2e relies on, update `README.md` and `CLAUDE.md` per the epic's "Documentation Deliverables", and add the architecture-lint fixture that asserts `stock_movement` is append-only. This is the only task that touches `README.md` / `CLAUDE.md`, and it reconciles all ten topic docs so the doc folder is internally consistent (cross-links resolve, no dangling "task-NN will…" forward refs left unfulfilled).

## Entry state assumed

Tasks 01–12 complete:

- The two tables, the seven use cases, the cross-service wiring, the endpoints, the cache bump, and the e2e all exist.
- `RESERVATION_TTL_MINUTES` is in the Joi schema (task-03) but **not** in `.env.example` / `.env.local`.
- `PermissionCodeEnum.INVENTORY_TRANSFER` exists (task-07) but is **not** seeded.
- Docs `01-…` through `10-…` exist (each written by its owning task).
- `spec/architecture-lint.spec.ts` has the `epic-04` fixtures but no `stock_movement` append-only assertion.

## Scope

**In:**

- `.env.example` + `.env.local` — add `RESERVATION_TTL_MINUTES=15`.
- `scripts/test-db-seed.ts` (+ `scripts/seeds/` if SQL-file-based) — seed `inventory:transfer` into `warehouse-staff`; seed a `secondary-warehouse` `stock_location` (so the transfer Kulala request + e2e have a real destination); ensure the variant-with-controlled-stock fixtures the e2e needs are deterministic.
- `README.md` — System diagram (add Reservation + StockMovement boxes + the new RPCs); API → Inventory (add `/movements`, `/reservations/:id/release`, `/stock/transfer`); a new **Inventory invariants** subsection (no-oversell + OCC); Caching → cache key updated to `v3`.
- `CLAUDE.md` — stock-module file-listing (`reservation.entity.ts`, `stock-movement.entity.ts`, the new ports + adapters + use cases); Message patterns (the four new keys + three new RPCs + the cancel/transfer/query RPCs); Operational notes cross-service-events bullet (reserve/allocate/release chain); Cache-key convention (`INVENTORY_STOCK_KEY_VERSION='v3'`).
- `spec/architecture-lint.spec.ts` — fixture asserting no `UPDATE`/`DELETE` against `stock_movement` (the append-only guarantee from task-02 / ADR-017).
- Reconcile the ten docs: fix cross-links, ensure each forward-ref ("task-NN does X") points at delivered work, add an `index`/intro paragraph if the doc folder convention from prior epics has one.

**Out:**

- Any new feature code — this is a closeout pass.
- New ADRs — this epic honors existing ADRs; it introduces no new architectural decision requiring a record. (If, during implementation, a genuinely new decision was made — e.g. modeling Transfer as paired `adjustment` movements rather than a new enum value — capture it as ADR-025 in a **separate** follow-up, not silently here. Flag it for the author rather than authoring it unprompted.)

## README updates — specifics

- **System diagram:** add a `Reservation` box and a `StockMovement` box inside the inventory service; draw the three new RPC arrows (retail → inventory: `reserve`, `release`, `allocate`) and note the four new events.
- **API → Inventory:** a table row per new endpoint with method/path/auth.
- **Inventory invariants (new subsection):** the no-oversell formula, the OCC mechanism (`@VersionColumn` + the guarded UPDATE + retry-then-409), and the TTL-bounded reservation contract. Cross-link the `docs/implementation/07-…/03-…` doc.
- **Caching → Cache key:** update the documented inventory stock key to `ris:inventory:stock:v3:<variantId>[:<facet>]`.

## CLAUDE.md updates — specifics

- **Stock module file-listing:** add `reservation.entity.ts` / `reservation.model.ts`, `stock-movement.entity.ts` / `stock-movement.model.ts`, `RESERVATION_REPOSITORY` / `STOCK_MOVEMENT_REPOSITORY`, the new use cases (`reserve-stock`, `release-reservation`, `allocate-stock`, `cancel-allocation`, `transfer-stock`, `query-movements`), and the three new publisher emits.
- **Message patterns:** add `inventory.stock.reserved`, `inventory.stock.allocated`, `inventory.stock.released`, `inventory.stock-movement.recorded` (events) and `inventory.reservation.reserve/release/allocate`, `inventory.allocation.cancel`, `inventory.stock.transfer`, `inventory.stock-movement.query` (RPCs); note the retired `inventory.order.confirm` handler.
- **Operational notes — cross-service events bullet:** mention the reserve/allocate/release chain (retail cart ↔ inventory reservation) and that `inventory.stock-movement.recorded` is the high-volume catch-all for `epic-11`'s event-store.
- **Cache-key convention:** `INVENTORY_STOCK_KEY_VERSION='v3'`.

## Architecture-lint fixture

Add to `spec/architecture-lint.spec.ts` (or the inventory-specific arch spec) a test that fails if the `StockMovement` repository ever issues a mutation:

- A fixture/grep asserting `stock-movement-typeorm.repository.ts` contains no `.update(` / `.delete(` / `UPDATE stock_movement` / `DELETE FROM stock_movement` against the movement entity.
- An assertion that `IStockMovementRepositoryPort` has no `update`/`delete` member (the port surface is the contract).

Follow the existing fixture-suite style (the bumper that re-asserts each rule fires — so a silent loosening fails CI).

## Files to add

None (all docs exist; this task edits).

## Files to modify

- `.env.example`, `.env.local` — `RESERVATION_TTL_MINUTES=15`.
- `scripts/test-db-seed.ts` (+ `scripts/seeds/*.sql` if used) — `inventory:transfer` into `warehouse-staff`; `secondary-warehouse` stock_location; deterministic e2e fixtures.
- `README.md` — the four areas above.
- `CLAUDE.md` — the four areas above.
- `spec/architecture-lint.spec.ts` — the append-only fixture.
- `docs/implementation/07-inventory-reservation-and-stock-movement/01-…md` … `10-…md` — cross-link reconciliation pass.

## Files to delete

None.

## Tests

- `yarn test:seed` applies cleanly; `SELECT` confirms `inventory:transfer` is attached to `warehouse-staff` and `secondary-warehouse` exists in `stock_location`.
- `yarn test:unit` passes including the new arch-lint fixture (the append-only assertion is green for the real repo and would fail against a fixture that mutates `stock_movement`).
- `yarn lint` + `yarn build` pass.

## Doc deliverable

No new topic-numbered doc. This task's deliverable is the reconciliation: all ten docs cross-link correctly, every "task-NN does X" forward ref resolves to delivered work, and the README/CLAUDE updates land. Verify the doc folder has exactly the ten files the epic names.

## Carryover produced

- The epic is complete: env, seed, README, CLAUDE.md, and the arch-lint fixture all reflect the new reservation/movement model.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes, including the append-only `stock_movement` arch-lint fixture.
- [ ] `yarn test:e2e` passes; `concurrent-oversell` stable across 5 runs (re-confirm after the seed changes).
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean; `reservation` + `stock_movement` tables present.
- [ ] `yarn test:seed` attaches `inventory:transfer` to `warehouse-staff` and creates `secondary-warehouse`.
- [ ] `README.md` System diagram + API + Inventory-invariants + Caching(`v3`) updated; `CLAUDE.md` stock-module + message-patterns + operational-notes + cache-note updated.
- [ ] The `docs/implementation/07-…/` folder has exactly the ten `*.md` files (`01-…` through `10-…`), cross-links resolve.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `scripts/`, `spec/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.
