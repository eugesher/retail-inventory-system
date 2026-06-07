---
epic: epic-04
source_epic_file: tmp/epics/epic-04-inventory-stock-level-and-location.md
---

# epic-04 — Task Index

This epic is decomposed into **6 self-contained tasks**, each sized for a single
cold-start session. Every task file states its **entry state** (what prior tasks
left on disk and in the `retail_db` schema), the **concrete files** it
adds/modifies/deletes, the **tests** it must write, its **doc deliverable**, and
its **exit criteria**. A task assumes nothing about future tasks; it relies only
on the repository as committed by prior tasks plus the `carryover-*.md` notes in
this folder. Run them strictly in order — there is no parallelism.

The capability delivered: a rebuilt inventory core. The append-only
`product_stock` ledger (with its `SUM/GROUP BY` read path) and the `storage`
table are replaced by a two-table running-totals model — **`StockLocation`** (one
auto-provisioned default warehouse) plus **`StockLevel`**
(`quantityOnHand` / `quantityAllocated` / `quantityReserved` + an optimistic-lock
`version`). Every key shifts from `productId` to `variantId` (the catalog
backbone). The inventory service auto-initialises a `StockLevel = 0` for each new
variant by consuming `catalog.variant.created`, and ships the Stage-1 operations
**Receive Stock**, **Adjust Stock**, and **Query Availability**. The cached read
value changes shape, so the cache-key schema version bumps `v1 → v2`.
Reservation, allocation, `StockMovement`, transfers, and concurrent-oversell
enforcement are explicitly **out of scope** (owned by later inventory
capabilities); this epic ships per-location running totals + the ingestion paths
only.

## Sequence and dependencies

| # | Task | Touches | Doc deliverable |
|---|---|---|---|
| 1 | [Drop the legacy inventory model; new `StockLocation` + `StockLevel` foundation](task-01-drop-legacy-model-and-new-foundation.md) | `apps/inventory-microservice/src/modules/stock/` (domain, persistence, ports, controller), `apps/api-gateway/src/modules/inventory/` (deleted), `libs/contracts/inventory/`, `libs/messaging/routing-keys.constants.ts`, `libs/contracts/microservices/`, `migrations/`, `scripts/seeds/product-stock.sql` (deleted), `scripts/utils/test-db-seed.util.ts`, `http/product.http` (deleted), `test/system-api.e2e-spec.ts`, `test/auth.e2e-spec.ts`, `CLAUDE.md`/`README.md` (only the dropped-route lines) | `01-old-tables-dropped-and-new-schema.md` + `02-default-stocklocation-auto-provision.md` + `03-stocklevel-aggregate-and-version-column.md` + **ADR-027** |
| 2 | [Inventory-side read path: contracts, cache `v2`, Query Availability + List Locations RPCs](task-02-read-rpcs-and-cache-v2.md) | `apps/inventory-microservice/src/modules/stock/{application,infrastructure,presentation}/`, `libs/contracts/inventory/`, `libs/cache/cache-keys.ts` (+ spec), `libs/messaging/routing-keys.constants.ts`, `libs/contracts/microservices/` | `04-cache-key-bump-v1-to-v2.md` |
| 3 | [API-gateway read endpoints + stock-level seed + availability e2e](task-03-gateway-read-endpoints-and-seed.md) | `apps/api-gateway/src/modules/inventory/` (rebuilt), `apps/api-gateway/src/app/app.module.ts`, `http/inventory.http` (new), `scripts/seeds/stock-level.sql` (new), `scripts/utils/test-db-seed.util.ts`, `test/inventory-availability.e2e-spec.ts` | `07-availability-read-path.md` |
| 4 | [Auto-init `StockLevel = 0` on `catalog.variant.created`](task-04-auto-init-consumer.md) | `apps/inventory-microservice/src/modules/stock/{application,infrastructure/consumers,domain}/`, `apps/catalog-microservice/.../catalog/infrastructure/messaging/catalog-rabbitmq.publisher.ts` + its module, `libs/messaging/routing-keys.constants.ts`, `libs/contracts/microservices/`, `test/inventory-auto-init.e2e-spec.ts` | `05-auto-init-on-variant-created.md` |
| 5 | [Receive Stock + Adjust Stock write operations, events, gateway POST endpoints](task-05-receive-and-adjust-operations.md) | `apps/inventory-microservice/src/modules/stock/{domain,application,infrastructure/messaging,presentation}/`, `apps/api-gateway/src/modules/inventory/`, `apps/notification-microservice/.../consumers` + low-stock use case, `libs/contracts/inventory/`, `libs/messaging/routing-keys.constants.ts`, `http/inventory.http`, `test/inventory-receive-and-adjust.e2e-spec.ts`, `test/inventory-cache.e2e-spec.ts` | `06-receive-and-adjust-use-cases.md` |
| 6 | [Docs + README/CLAUDE + lint-fixtures finalization](task-06-docs-and-finalization.md) | `docs/implementation/04-inventory-stock-level-and-location/08-*.md`, `README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts` | `08-inventory-http-file.md` (+ README / CLAUDE) |

## Carryover chain

Each task `NN` ends by writing `carryover-NN.md` in this folder. Each task `N`
begins by reading **every** prior `carryover-01.md … carryover-(N-1).md` in
order. The carryover files are the only transition markers and live only under
this folder — never in source, docs, `README.md`, or `CLAUDE.md`. Do the tasks
in order; do not parallelize.

## Document-deliverable map

Implementation docs live under
`docs/implementation/04-inventory-stock-level-and-location/`. Each task writes
its own doc(s) **as part of its Definition of Done** (a task is not complete
until its doc explains the what and why). No doc is split across tasks in this
epic — each topic doc is authored whole by one task.

| Doc | Written by |
|---|---|
| `01-old-tables-dropped-and-new-schema.md` | task-01 |
| `02-default-stocklocation-auto-provision.md` | task-01 |
| `03-stocklevel-aggregate-and-version-column.md` | task-01 |
| `04-cache-key-bump-v1-to-v2.md` | task-02 |
| `05-auto-init-on-variant-created.md` | task-04 |
| `06-receive-and-adjust-use-cases.md` | task-05 |
| `07-availability-read-path.md` | task-03 |
| `08-inventory-http-file.md` | task-06 |

**ADR:** task-01 records **ADR-027**
(`docs/adr/027-stocklevel-running-totals-and-stocklocation.md`) — the shift from
the `product_stock` ledger-as-source-of-truth to per-location `StockLevel`
running totals; the single auto-provisioned `StockLocation` (Open Question Q8);
the `version` optimistic-concurrency column shipped now though enforcement is
deferred; and the `productId → variantId` keying shift. It **supersedes ADR-012**
(`StockItem` / `product_stock`), so task-01 flips ADR-012's `Status` line to
`Superseded by ADR-027` and adds a one-line pointer (the only edit an accepted
ADR may receive — ADR-003). The 3-digit number is allocated at task-01's first
commit; if `027` is taken when the task runs, take the next free number and
record it in `carryover-01.md`. No other task introduces an ADR; no task may
violate an accepted ADR. **Note on event delivery:** task-04 retargets the
catalog `catalog.variant.created` emit onto `inventory_queue` (the consumer's
queue) — this *applies* the existing producer-targets-consumer-queue pattern
(ADR-008 / ADR-020), so it needs **no** new ADR. Only if an executor instead
introduces a fanout/topic exchange would a new ADR be required (not the
recommended path).

## README.md + CLAUDE.md updates

`README.md` (system diagram, API → Stock section, Caching key shape) and
`CLAUDE.md` (stock-module file listing, message-pattern list, cache-version note,
operational-notes cache bullet) receive their **full pass in task-06** (the
finalization), except the minimal dropped-route edits task-01 must make
in-lockstep when it deletes the old `GET /api/product/:productId/stock` endpoint
and the `inventory.product-stock.get` RPC (so no deliverable describes a route
that no longer exists). The `spec/architecture-lint.spec.ts` regression fixtures
for the inventory `stock` module already exist; task-06 re-verifies them and adds
a fixture locking the new `infrastructure/consumers/` boundary if useful (no new
module is introduced, so no `eslint.config.mjs` change is expected).

## Cleanup-first task

**task-01 is the cleanup-first task.** The inventory model is *replaced*, so the
obsolete artifacts are extensive: the `product_stock`, `product_stock_action`,
and `storage` tables; the `StockItem` / `Storage` domain models; the
`product-stock` entities, mappers, and old repository; the `add-stock` /
`get-stock` / `reserve-stock-for-order` use cases; the `StockCache` (rebuilt
later under the `v2` key); the entire gateway `modules/inventory/` (rebuilt
later); the `ProductStockGetResponseDto` read contract; the
`inventory.product-stock.get` routing key; `http/product.http`; and
`scripts/seeds/product-stock.sql`. task-01 **deletes** every one of these (it
never renames to `legacy`/`old`/`_v1`) and fixes or deletes every reference the
removals leave dangling **in the same session** — including the two e2e specs
(`system-api`, `auth`) that exercised the dropped route — so the monorepo
compiles, lints, and passes `unit` + `e2e` at the end of task-01 with a bootable
(operation-free) inventory service. The epic's hint to leave a throwing
repository stub is **not** followed: a throwing stub plus deleted entities would
not compile, violating the per-task green-build rule; task-01 instead lays the
real new foundation. The one artifact deliberately **kept** is the
`inventory.order.confirm` RPC + `IProductStockOrderConfirmPayload` contract,
reduced to a deprecation-error stub so the retail confirm seam still resolves to
an explicit error (the seam itself is removed by a later inventory-reservation
capability).

## Self-containment rule

No file under `docs/`, `apps/`, `libs/`, `http/`, `scripts/`, `spec/`,
`migrations/`, `README.md`, or `CLAUDE.md` may reference any path under `tmp/`,
or use the words "epic"/"task" as names for this planning process. Forward and
backward work is described by capability (e.g. "the inventory-reservation
capability", "a later audit-log capability"), never by an epic/task number.
Implementation docs are organised by number + topic slug
(`01-old-tables-dropped-and-new-schema.md`), never by an epic/task breadcrumb.

## Cumulative exit criteria (gate for "all tasks complete")

- [ ] `yarn lint` passes (`--max-warnings 0`); the inventory `stock` module's
      boundaries match the existing module shapes.
- [ ] `yarn test:unit` passes; ≥7 inventory spec files green
      (`stock-location.model`, `stock-level.model`, `query-availability.use-case`,
      `list-locations.use-case`, `auto-init-stock-level.use-case`,
      `receive-stock.use-case`, `adjust-stock.use-case`) plus the updated
      `stock.cache.spec.ts`.
- [ ] `yarn test:e2e` passes; `test/inventory-receive-and-adjust.e2e-spec.ts`
      and `test/inventory-cache.e2e-spec.ts` are green (plus the
      availability + auto-init e2e specs).
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean;
      `SHOW COLUMNS FROM stock_location` and `SHOW COLUMNS FROM stock_level` show
      the new tables (the latter with a `version` column); `SELECT * FROM
      stock_location` returns the auto-provisioned `default-warehouse`.
- [ ] Every request in `http/inventory.http` executes; `http/product.http` is
      gone.
- [ ] After `yarn test:seed`, `GET /api/inventory/variants/:variantId/stock`
      returns 100 units at `default-warehouse` for each seeded variant.
- [ ] Redis: cache keys observed via `--scan` match
      `ris:inventory:stock:v2:<variantId>:<facet>`; no `v1`-prefixed keys are
      written on the new code path.
- [ ] Creating a new Variant via the catalog flow results in a new
      `StockLevel = 0` row at `default-warehouse` within seconds (verified by
      polling the inventory GET).
- [ ] Per-topic docs `01 … 08` present under
      `docs/implementation/04-inventory-stock-level-and-location/`; ADR-027 is
      recorded and ADR-012 is marked superseded.
- [ ] `README.md` System diagram + API + Caching sections updated; `CLAUDE.md`
      stock-module + message-patterns + cache notes updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `scripts/`, `spec/`,
      `migrations/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`
      or uses the words "epic"/"task".
