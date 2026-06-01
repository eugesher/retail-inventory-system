---
id: epic-04
title: Inventory foundation — StockLocation (one default) + StockLevel running totals
source_stages: [walking-skeleton]
depends_on: [epic-02]
microservices: [api-gateway, inventory-microservice]
task_subfolder: tmp/tasks/epic-04-inventory-stock-level-and-location/
docs_subfolder: docs/implementation/04-inventory-stock-level-and-location/
---

# Epic 04 — Inventory foundation — StockLocation (one default) + StockLevel running totals

## Goal

Rebuild the inventory microservice's core model. Replace the existing `product_stock` ledger-as-source-of-truth with a two-table model: `StockLocation` (one auto-provisioned default per Q8) + `StockLevel` running totals (`quantityOnHand`/`quantityAllocated`/`quantityReserved` + `version` for optimistic concurrency). All keys shift from `productId` to `variantId` (referencing `epic-02`'s `product_variant`). Wire the inventory consumer of `catalog.variant.created` so that creating a Variant auto-initializes `StockLevel = 0` at the default location. Implement Stage-1 inventory operations: Receive Stock, Adjust Stock, Query Availability. Bump the cache key version from `v1` to `v2` (per ADR-022) since the DTO shape changes. **Reservation, StockMovement, Allocate, Commit Sale, Cancel Allocation, Restock from Return, Transfer Stock are deferred to `epic-07`** — this epic delivers the per-location running totals + ingestion paths only.

## In-Scope Entities and Operations

- **StockLocation**: `id` (string PK, e.g. `default-warehouse`), `name`, `code` (unique), `type` (`warehouse` | `store` | `dropship-virtual`), `address` (JSON nullable), `gln` (GS1 Global Location Number, optional), `active` (boolean), `createdAt`, `updatedAt`. **Exactly one row auto-provisioned at install** (id = `default-warehouse`, type = `warehouse`, active = true).
- **StockLevel**: `id`, `variantId` (FK to `product_variant.id` — cross-service FK; integrity enforced at the application layer + via the auto-init consumer, since the inventory microservice owns this table but `product_variant` lives in catalog), `stockLocationId` (FK to `stock_location.id`), `quantityOnHand` (INT default 0), `quantityAllocated` (INT default 0), `quantityReserved` (INT default 0), `version` (INT default 0; optimistic-concurrency token), `createdAt`, `updatedAt`. Unique constraint on `(variantId, stockLocationId)`.
- **Operations:**
  - **Receive Stock** (User; `inventory:adjust`) — preconditions: location active, variant exists. Outcome: `quantityOnHand += n`. **No StockMovement row written by this epic** — the movement-as-ledger entity is owned by `epic-07`; until then, the operation is recorded only in Pino + via a future audit-log emission (`epic-11`).
  - **Adjust Stock** (User; `inventory:adjust`) — preconditions: `reasonCode` mandatory (carried in request body, written into the future-StockMovement payload but not yet persisted in a table). Signed delta to `quantityOnHand`.
  - **Query Availability** (Customer/User; public) — read-only `available = quantityOnHand − quantityAllocated − quantityReserved`, optionally aggregated across locations. **Cache-aside read path** preserved per ADR-002/006/016/021 — but the cache key bumps to `v2` and the cached value shape changes from a SUM aggregate to a `StockLevel` projection.

## Non-Goals

- **Reservation** (entity + Reserve Stock + Release Reservation operations) — owned by `epic-07`.
- **StockMovement** (typed ledger with `type`/`reasonCode`/polymorphic reference) — owned by `epic-07`.
- **Allocate Stock, Commit Sale, Cancel Allocation, Restock from Return, Transfer Stock** — owned by `epic-07` and `epic-08`/`epic-09`.
- **Lot/batch/serial tracking, expiry/FIFO, bin/aisle/shelf, demand forecasting, transfer-order documents, consigned inventory, ABC classification, in-transit-as-separate-location** — Exclusions Register (`epic-15`).
- **Multi-location order routing** — Exclusions Register (`epic-15`); the report calls this the first natural extension beyond the universal core.

## Architectural Decisions Honored

- **Open Question Q8** — exactly one default `StockLocation` is auto-provisioned at install (per Vendure's pattern). Making it optional creates a migration hazard the moment a second warehouse appears. The provisioning lives in a TypeORM migration (deterministic, idempotent — `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE`).
- **Cross-Cutting "Concurrency & consistency"** — the no-oversell invariant lives on `StockLevel`. This epic adds the `version` column for optimistic concurrency; the actual enforcement of the invariant lands in `epic-07` (where reservation/allocation arrive) and is hardened in `epic-12`. This epic must ship `version` columns from the start so the OCC retrofit in epic-07/12 is non-destructive.
- **Cross-Cutting "Multi-location / multi-warehouse"** — `StockLocation`, `StockLevel`, `StockMovement`, and `Reservation` are location-aware at the universal core level. Order is not location-aware at the header level (sourcing is per-fulfillment, owned by `epic-08`).
- **Cross-Cutting "Event emission"** — `StockReserved`, `StockAllocated`, `StockCommitted` (sale), `StockReleased` are mandatory state-transition events — but they belong to operations owned by `epic-07`/`epic-08`/`epic-09`. This epic emits only `StockReceived` and `StockAdjusted` events (new routing keys, see below).
- **Cross-Cutting "Soft delete vs hard delete":** StockLocation is soft-delete (use `active=false`, never `deletedAt`); StockLevel rows are never deleted (use deactivation of the parent location).
- **ADR-002 / ADR-006 / ADR-016** (cache-aside): the cache-aside contract is preserved. The cached value is now a `StockLevel` projection (or list of projections), not a SUM aggregate.
- **ADR-021** (single-flight + TTL jitter): inherited automatically via `IStockCachePort.getOrLoad` (no code change required on this path).
- **ADR-022** (cache-key schema version): `INVENTORY_STOCK_KEY_VERSION` constant bumps `v1` → `v2`. Pre-bump entries become unreachable on the next deploy — acceptable since no production data exists.
- **ADR-023** (post-commit cache invalidation by type): the existing `IStockCachePort.withInvalidation(work, resolveItems, opts)` contract is preserved; Receive Stock / Adjust Stock route writes through it. The `resolveItems` function returns `[{ variantId, stockLocationId }]` (was `[{ productId, storageId }]` — DTO shape change, hence the version bump).
- **ADR-017** (boundaries lint): unchanged; the existing stock-module layout absorbs the new entities under the same `domain/application/infrastructure/presentation` split.
- **ADR-019** (TypeORM + MySQL): the existing `product_stock` table is **dropped** along with `product_stock_action` and `storage` (replaced by `stock_location`); `product` (the inventory-side stub) is dropped (already done by `epic-02`'s task 8 if it ran first; otherwise this epic does it).
- **ADR-010** (RBAC at the gateway): `inventory:adjust` gates Receive/Adjust; `inventory:read` gates Query Availability admin endpoints; the customer-facing Query Availability is public.

## Persistence Changes

**Added (in inventory-microservice):**

- `stock_location` table: `id` (VARCHAR(64) PK), `name`, `code` (unique), `type` (ENUM: `warehouse` | `store` | `dropship-virtual`), `address` (JSON nullable), `gln` (VARCHAR(13) nullable), `active` (BOOL default true), timestamps.
- `stock_level` table: `id` (BIGINT PK), `variant_id` (INT FK-by-convention), `stock_location_id` (VARCHAR(64) FK to `stock_location.id`), `quantity_on_hand` (INT default 0 NOT NULL), `quantity_allocated` (INT default 0 NOT NULL), `quantity_reserved` (INT default 0 NOT NULL), `version` (INT default 0 NOT NULL), timestamps.

**Removed:**

- `product_stock` table (the old delta ledger).
- `product_stock_action` lookup table.
- `storage` table (replaced by `stock_location`).
- The inventory-microservice's old `product` table (if not already dropped by `epic-02` task 8).
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts` — deleted.
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts` — deleted (and replaced by `stock-level.entity.ts`).
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock-action.entity.ts` — deleted.
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/storage.entity.ts` — renamed/replaced by `stock-location.entity.ts`.

**Indexes & constraints:**

- Unique index on `stock_level (variant_id, stock_location_id)`.
- Index on `stock_level (stock_location_id)` (for location-scoped scans).
- CHECK constraints (where the MySQL version supports them) on `quantity_on_hand >= 0`, `quantity_allocated >= 0`, `quantity_reserved >= 0`. Where unsupported, enforce in the use case + aggregate.
- Unique index on `stock_location.code`.
- The `version` column is the optimistic-concurrency token (TypeORM `@VersionColumn()`).

**Cache key version bump:**

- `libs/cache/cache-keys.ts`: `INVENTORY_STOCK_KEY_VERSION` changes from `'v1'` to `'v2'`. The `inventoryStockLegacyPrefix` builder (added during the ADR-022 transition window) gains a second legacy prefix entry for the `v1` keys this bump retires. The pre-ADR-016 `productStockPrefix` legacy entry stays as long as ADR-023 §"transition window" requires.

## Eventing / Messaging

- **New routing keys (added to `libs/messaging/routing-keys.constants.ts`):**
  - `inventory.stock.received` — emitted on Receive Stock; payload: `{ variantId, stockLocationId, quantityDelta (positive), newOnHand, actorId, eventVersion: 'v1', correlationId }`.
  - `inventory.stock.adjusted` — emitted on Adjust Stock; payload: `{ variantId, stockLocationId, quantityDelta (signed), reasonCode, newOnHand, actorId, eventVersion: 'v1', correlationId }`.
  - `inventory.stock-level.initialized` — emitted on the auto-init path (new StockLevel row at 0); payload: `{ variantId, stockLocationId, eventVersion: 'v1', correlationId }`.
- **New consumer:** inventory-microservice subscribes to `catalog.variant.created` (from `epic-02`); on receipt, creates a `StockLevel = 0` row for the new variant at the auto-provisioned default location. Idempotent — repeat events do not duplicate rows.
- **Preserved:** the existing `inventory.stock.low` event (defined in `libs/contracts/inventory/events/stock-low.event.ts`) and the existing notification consumer of it. The threshold semantics are unchanged. The publisher path adapts to the new `StockLevel.quantityOnHand` source instead of the old aggregate.
- **Retired:** the legacy `inventory.product-stock.get` RPC and `inventory.order.confirm` RPC (the latter is repurposed in `epic-07` into the Reservation/Allocation flow; for now its handler returns a deprecation error if called).

## API Surface

**New / modified HTTP endpoints in `api-gateway`** (extending `modules/inventory/`):

| Method | Path | Body / params | Auth | Response |
|---|---|---|---|---|
| `GET` | `/api/inventory/locations` | — | bearer + `inventory:read` | list of StockLocation rows |
| `GET` | `/api/inventory/variants/:variantId/stock` | query: `?locationIds=…` | `@Public()` | per-location availability + total; cached |
| `POST` | `/api/inventory/variants/:variantId/stock/receive` | `{ stockLocationId?, quantity }` | bearer + `inventory:adjust` | updated StockLevel projection |
| `POST` | `/api/inventory/variants/:variantId/stock/adjust` | `{ stockLocationId?, quantityDelta, reasonCode }` | bearer + `inventory:adjust` | updated StockLevel projection |

**Modified:** the legacy `GET /api/product/:productId/stock` endpoint (from epic-02 it should already be archived/removed since `productId` no longer addresses a stockable unit; if this epic finds it still present, it is removed). `http/product.http` becomes obsolete and is **deleted** as part of this epic — replaced by `http/inventory.http` below.

**Kulala HTTP files** (under `http/`):

- **`http/inventory.http`** — NEW; covers all four endpoints above. Header documents the seeded `default-warehouse` location id and explains that omitting `stockLocationId` in the body targets that default. Replaces `http/product.http` (which is deleted).

## Test Strategy

**Unit tests:**

- `apps/inventory-microservice/src/modules/stock/domain/spec/stock-location.model.spec.ts` — `code` uniqueness invariant (asserted via test double), `active` toggle, type enum.
- `apps/inventory-microservice/src/modules/stock/domain/spec/stock-level.model.spec.ts` — non-negative quantities, `available = onHand − allocated − reserved` derived getter, `version` bumps on every mutation.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/receive-stock.use-case.spec.ts` — happy path + non-positive-quantity-rejected + location-must-be-active + cache invalidate routed through `withInvalidation`.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/adjust-stock.use-case.spec.ts` — signed delta; `reasonCode` mandatory; result must not push `onHand` below zero; cache invalidate routed through `withInvalidation`.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/query-availability.use-case.spec.ts` — cache hit/miss/error paths inherit from existing get-stock spec; new shape asserted.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/auto-init-stock-level.use-case.spec.ts` — new: consumer of `catalog.variant.created`; idempotency on repeat.
- Update existing `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts` for the new key version + new payload shape.

**E2E tests:**

- `test/inventory-receive-and-adjust.e2e-spec.ts`:
  1. Customer creates a Variant via the catalog flow (epic-02).
  2. Inventory auto-init consumer creates `StockLevel = 0` at `default-warehouse` (asserted by hitting `/api/inventory/variants/:id/stock`).
  3. Admin Receives 50 units → `quantityOnHand = 50`, `available = 50`.
  4. Admin Adjusts -3 (reason `damaged`) → `quantityOnHand = 47`, `available = 47`.
  5. Public `GET /api/inventory/variants/:id/stock` returns the new figure (cache miss then hit).
  6. Admin tries `Adjust -100` → `409` (would push below zero).
- `test/inventory-cache.e2e-spec.ts`:
  1. Same setup as above; verify that after Receive Stock, the next public GET returns the post-commit value (proves invalidation runs post-commit per ADR-023).

**Concurrency tests:** NOT in this epic — concurrent oversell tests land in `epic-07` once Reservation exists.

**Seed data required:**

- Migration auto-provisions `default-warehouse` `StockLocation`.
- `scripts/test-db-seed.ts` extended: for each seeded variant, simulate auto-init by ensuring a `StockLevel` row exists (because the seed may run before any RMQ consumer is up). Seed 100 `quantityOnHand` for each seeded variant.
- Permission codes `inventory:read`, `inventory:adjust` seeded into the `warehouse-staff` role (already seeded by `epic-01`'s permission floor).

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/04-inventory-stock-level-and-location/`:

- `01-old-tables-dropped-and-new-schema.md` — what was deleted (product_stock, product_stock_action, storage, product), what was added (stock_location, stock_level), with the rationale (running totals over ledger-as-source).
- `02-default-stocklocation-auto-provision.md` — Q8 decision restated; idempotent migration insert; how to add a second location later.
- `03-stocklevel-aggregate-and-version-column.md` — the optimistic-concurrency token; why it ships now even though enforcement lands in epic-07/12.
- `04-cache-key-bump-v1-to-v2.md` — the ADR-022-style bump; what legacy prefixes are kept; what unreachable entries on Redis will look like.
- `05-auto-init-on-variant-created.md` — the new RMQ consumer; idempotency strategy; what happens if the consumer is down at variant-create time (lazy re-init on first stock op).
- `06-receive-and-adjust-use-cases.md` — happy paths + invariants; reason-code requirement; the deferred StockMovement persistence is referenced explicitly with a forward link to `epic-07`'s doc folder.
- `07-availability-read-path.md` — cache-aside preserved; new payload shape; per-location vs aggregated read.
- `08-inventory-http-file.md` — `http/inventory.http` shape; replaces `http/product.http`.

**`README.md` updates required:**

- **System diagram** updated to show `stock_location` + `stock_level` (instead of `product_stock` / `storage`) and to drop the legacy `product` box from inventory.
- **API → Stock** section replaced with the new endpoint list.
- **Caching → Cache key** section updated to show the new key shape (`ris:inventory:stock:v2:<variantId>:<facet>`) and to note the version bump from `v1` to `v2`.
- **Caching → Inspecting the cache** snippet updated to use `variantId` and the new prefix.
- **Database** section: brief note on the auto-provisioned `default-warehouse`.

**`CLAUDE.md` updates required:**

- Replace the **stock module** file-listing in Architecture with the new entity set (`stock-location.entity.ts`, `stock-level.entity.ts`).
- Update the **Message patterns** list: remove `inventory.product-stock.get`; add `inventory.stock.received`, `inventory.stock.adjusted`, `inventory.stock-level.initialized`. Mark `inventory.order.confirm` as "reshaped in epic-07".
- Update **Shared Libraries → cache** to mention `INVENTORY_STOCK_KEY_VERSION='v2'`.
- Update **Operational notes** bullet on cache-aside to reflect the new key.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Drop the old inventory tables + entity files.** Migration removes `product_stock`, `product_stock_action`, `storage`, `product` (if not already removed by epic-02). Delete the four entity .ts files. Update `StockTypeormRepository` to a stub that does nothing (compiles but throws on every method) — short-lived intermediate state.
2. **Add `stock_location` + auto-provision the default.** New entity + mapper + migration with idempotent INSERT.
3. **Add `stock_level` with version column.** New entity + mapper + repository.
4. **Rewrite `StockItem` domain aggregate as `StockLevel` aggregate.** Update domain spec; events file kept but moved/renamed where needed (`StockReservedEvent`/`StockReleasedEvent`/`StockLowEvent` keep their files; new placeholder events for `StockReceivedEvent`/`StockAdjustedEvent`/`StockLevelInitializedEvent`).
5. **Rewrite use cases.** Delete `add-stock.use-case.ts` (replaced by `receive-stock` + `adjust-stock`). Rewrite `get-stock.use-case.ts` as `query-availability.use-case.ts` against the new aggregate. `reserve-stock-for-order.use-case.ts` is retired (replaced in epic-07).
6. **Bump cache key version and rewrite `StockCache`.** `INVENTORY_STOCK_KEY_VERSION` → `'v2'`; legacy prefix added; payload shape changed; spec updated.
7. **Add the variant-created consumer.** Subscribe to `catalog.variant.created`; auto-init `StockLevel = 0` at default location; idempotent.
8. **Wire the new RMQ publisher.** Emit `inventory.stock.received` / `inventory.stock.adjusted` / `inventory.stock-level.initialized`.
9. **Rewrite the api-gateway `modules/inventory/`.** New port + use cases + controller + DTOs + pipes. Delete the old `product.controller.ts` from the gateway. Delete `http/product.http`. Author `http/inventory.http`.
10. **Seed + docs pass:** extend seed (stock-level rows for seeded variants), write the eight `docs/implementation/.../*.md` files, update `README.md` + `CLAUDE.md`, extend `spec/architecture-lint.spec.ts` fixtures.

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-02` + `epic-03` complete; catalog publishes events. | Migration dropping 4 tables; 4 entity files deleted; `StockTypeormRepository` stub state; `docs/implementation/04-…/01-…md`. |
| 2 | Task 1 carryover present. | `stock-location.entity.ts`, mapper, repository methods, migration with default-warehouse INSERT; `02-…md`. |
| 3 | Tasks 1–2 carryover present. | `stock-level.entity.ts`, mapper, repository methods, migration creating the table with `version`; `03-…md`. |
| 4 | Tasks 1–3 carryover present. | Rewritten `stock-level.model.ts` aggregate (replacing `stock-item.model.ts` — the file is renamed); event files updated; domain spec rewritten. |
| 5 | Tasks 1–4 carryover present. | New use case files (`receive-stock`, `adjust-stock`, `query-availability`), specs, ports updated; old use cases deleted; `06-…md`, `07-…md`. |
| 6 | Tasks 1–5 carryover present. | Updated `libs/cache/cache-keys.ts` (`v1`→`v2` + legacy entry); updated `stock.cache.ts`; updated spec; `04-…md`. |
| 7 | Tasks 1–6 carryover present. | New consumer file under `apps/inventory-microservice/.../infrastructure/consumers/`; new use case `auto-init-stock-level.use-case.ts` + spec; `05-…md`. |
| 8 | Tasks 1–7 carryover present. | Updated `stock-rabbitmq.publisher.ts` with the three new routing keys; routing-key constants added in `libs/messaging/`. |
| 9 | Tasks 1–8 carryover present. | Rewritten `apps/api-gateway/src/modules/inventory/`; deleted `http/product.http`; new `http/inventory.http`; `08-…md`. |
| 10 | All prior tasks complete. | Updated seed, README, CLAUDE.md, architecture-lint fixtures. |

## Exit Criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; ≥7 inventory spec files green plus the updated cache spec.
- [ ] `yarn test:e2e` passes; `test/inventory-receive-and-adjust.e2e-spec.ts` and `test/inventory-cache.e2e-spec.ts` green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean; `\d stock_location` and `\d stock_level` show the new tables with the `version` column on the latter; `SELECT * FROM stock_location` returns the auto-provisioned `default-warehouse`.
- [ ] Every request in `http/inventory.http` executes; `http/product.http` is gone.
- [ ] After `yarn test:seed`, `GET /api/inventory/variants/:variantId/stock` returns 100 units at `default-warehouse` for each seeded variant.
- [ ] Redis: cache keys observed via `--scan` match the new `ris:inventory:stock:v2:<variantId>:<facet>` pattern; no `v1`-prefixed keys are written on the new code path.
- [ ] Creating a new Variant via the catalog flow results in a new `StockLevel = 0` row at `default-warehouse` within seconds (verified by polling the inventory GET).
- [ ] Per-task docs present under `docs/implementation/04-inventory-stock-level-and-location/`.
- [ ] `README.md` System diagram + API + Caching sections updated; `CLAUDE.md` stock-module + message-patterns + cache notes updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
