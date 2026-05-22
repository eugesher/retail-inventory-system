---
epic: epic-04
task_number: 10
title: Seed + documentation pass — README, CLAUDE.md, arch-lint, test seed, e2e
depends_on: [01, 02, 03, 04, 05, 06, 07, 08, 09]
doc_deliverable: closing append to docs/implementation/epic-04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md
---

# Task 10 — Seed + documentation pass

## Goal

Close out epic-04. Extend the test seed so each seeded variant from epic-02 has a `StockLevel = 100` row at `default-warehouse`. Add the two e2e specs the epic requires (`test/inventory-receive-and-adjust.e2e-spec.ts` and `test/inventory-cache.e2e-spec.ts`). Update `README.md` (System diagram + API → Stock section + Caching section + Database section). Update `CLAUDE.md` (stock-module file-listing + Message patterns + Shared Libraries → cache + Operational notes). Extend `spec/architecture-lint.spec.ts` to govern the new directory shape under `apps/inventory-microservice/src/modules/stock/`. Write the closing append to `docs/implementation/epic-04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md` — the cumulative "after" schema diagram snapshot referenced from the introductory half written in task-01.

The closeout has no new code in `apps/`/`libs/` beyond the seed extension, the e2e tests, and the arch-lint fixtures. Every other surface of the codebase is in its final epic-04 state when this task starts.

## Entry state assumed

Task-09 carryover present:

- The four api-gateway endpoints work end-to-end against the inventory microservice; `http/inventory.http` is the kulala flow.
- The inventory microservice has the new domain + use cases + cache + publisher + consumer wired.
- Three new doc files exist under `docs/implementation/epic-04-inventory-stock-level-and-location/` from tasks 02 / 04 / 06 / 07 / 09 (each task wrote at least one doc; tasks 05 wrote two; tasks 01 + 03 wrote partial files that this task completes).
- Two existing docs have appended sections from task-08.
- No e2e test for the new endpoints exists yet.

## Scope

**In:**

- Extend `scripts/test-db-seed.ts`:
  - After `seedUsers`, run a new `seedStockLocations` step that asserts the `default-warehouse` row exists. (It is inserted by the migration in task-02, but the seed runs after `yarn migration:run` in CI so the row should already exist — the assert is defensive; if missing, the seed fails loudly rather than silently working against an inconsistent DB.)
  - Run a new `seedStockLevels` step that, for each seeded variant in epic-02's variant seed, inserts a `stock_level` row at `default-warehouse` with `quantityOnHand = 100`, `quantityAllocated = 0`, `quantityReserved = 0`, `version = 0`. The insert uses `INSERT IGNORE` (or `ON DUPLICATE KEY UPDATE id = id`) so a re-run after the auto-init consumer has already inserted a 0-stock row simply updates the seed value via a subsequent UPDATE. (Verify: the simpler approach is to use `INSERT … ON DUPLICATE KEY UPDATE quantity_on_hand = VALUES(quantity_on_hand)` which always converges on 100 regardless of whether the consumer ran first.)
  - The seed is fed by a list of `(variantId, quantity)` pairs read from `scripts/seeds/stock-levels.sql` (new file) — the same pattern the project uses for `permissions.sql` etc.; the SQL file is read via the existing `TestDbSeedUtil.readStatements`.
- New `scripts/seeds/stock-levels.sql`:
  ```sql
  INSERT INTO stock_level (variant_id, stock_location_id, quantity_on_hand)
  VALUES
    (1, 'default-warehouse', 100),
    (2, 'default-warehouse', 100)
  ON DUPLICATE KEY UPDATE quantity_on_hand = VALUES(quantity_on_hand);
  ```
  The variant IDs (1, 2) match the seeded variants from epic-02 task-09. If epic-02 seeds different IDs, this file is updated in lockstep — the task's exit criteria assert the post-seed count.
- New e2e test `test/inventory-receive-and-adjust.e2e-spec.ts`:
  1. Bootstrap an api-gateway test app + the inventory microservice via the existing Testcontainers harness (verify against the project's existing e2e test setup; if Testcontainers is not used, run against a docker-compose-launched stack).
  2. Use the `customer` user (seeded by epic-01) to create a Variant via the catalog flow (`POST /api/catalog/products` then `POST /api/catalog/variants` — verify the route shape against epic-02 task-09's seed expectations).
  3. Wait for the auto-init consumer to insert a `StockLevel = 0` row (poll the public read endpoint with a 3-second timeout). Assert `available === 0`, `quantityOnHand === 0`.
  4. As the `admin` user, `POST /api/inventory/variants/:id/stock/receive` with `{ quantity: 50 }`. Assert response `quantityOnHand === 50`, `available === 50`, `version === 1`.
  5. As the `admin` user, `POST /api/inventory/variants/:id/stock/adjust` with `{ quantityDelta: -3, reasonCode: 'damaged' }`. Assert `quantityOnHand === 47`, `available === 47`, `version === 2`.
  6. As any user (no auth), `GET /api/inventory/variants/:id/stock`. Assert `levels[0].available === 47`. (This call is a cache miss; the next identical call should be a cache hit but the e2e cannot easily distinguish — that's covered by the second e2e spec below.)
  7. As the `admin` user, `POST /api/inventory/variants/:id/stock/adjust` with `{ quantityDelta: -100, reasonCode: 'test-conflict' }`. Assert 409 status; assert the response body carries the typed error name `StockInvariantViolationError`.
- New e2e test `test/inventory-cache.e2e-spec.ts`:
  1. Same bootstrap; same variant create + auto-init wait.
  2. As `admin`, receive 50 units.
  3. Public `GET /api/inventory/variants/:id/stock` — assert `available === 50` (proves the post-commit invalidation ran; the read is from the DB because the cache was just invalidated).
  4. Public `GET` again — assert same `available === 50` (proves the second read was cached without going stale — there's no way to distinguish a cache hit from a fast DB read at the HTTP boundary, so the test really proves the invariant "same result on a re-read"; the spec note should say so).
  5. As `admin`, adjust `-10`. The cache key for the variant is now invalidated post-commit.
  6. Public `GET` again — assert `available === 40` (proves the second invalidate ran; previously cached 50 is gone).
  7. (Optional, if a Redis client is reachable from the test process) `--scan --pattern 'ris:inventory:stock:v2:<variantId>:*'` returns at most one entry between steps 6 and 7 (the freshly-written cache entry from step 6's read). Skip this assertion if the test harness does not expose a Redis client by convention.
- `spec/architecture-lint.spec.ts`:
  - Update the existing `describe('inventory-microservice fixtures', ...)` block (added in earlier epics) to govern the new directory shape — `domain/stock-level.model.ts`, `domain/stock-location.model.ts`, `domain/events/`, `domain/errors/`, `infrastructure/persistence/{stock-level,stock-location}.{entity,mapper}.ts`, `infrastructure/consumers/`, `infrastructure/cache/`, `infrastructure/messaging/`, `presentation/stock.controller.ts`.
  - The cross-module ban (already enforced for catalog ↔ pricing in epic-03) is inherited here: `apps/inventory-microservice/src/modules/stock/domain/**` may not import from `apps/catalog-microservice/**` (and vice-versa). Add explicit fixtures.
  - The `infrastructure/consumers/` subdir is a new element-type fixture — assert that a consumer can import from `application/use-cases/` but not from `domain/`.
- Update `README.md`:
  - **System diagram** — the inventory box's table list updates from `{product, product_stock, product_stock_action, storage}` to `{stock_location, stock_level}`. The arrow from catalog labeled `catalog.variant.created` is added (or thickened if already present from epic-02). The arrow from inventory labeled `inventory.stock.received|adjusted|low|level-initialized` is added.
  - **API → Stock** section — replace with the new endpoint list (the four endpoints from task-09 + the `GET /api/inventory/locations` listing).
  - **Caching → Cache key** section — update to show the new key shape `ris:inventory:stock:v2:<variantId>:<facet>`; explicitly note the v1 → v2 bump. The `inspecting the cache` snippet uses `variantId` instead of `productId` (Redis `--scan --pattern 'ris:inventory:stock:v2:*'`).
  - **Database** section — brief paragraph on the auto-provisioned `default-warehouse` (cross-link doc 02).
- Update `CLAUDE.md`:
  - **Stock module** file-listing under "Inventory microservice" section — replace the four-table mention with the two new aggregates + the new event files + the new consumer.
  - **Message patterns** list — remove `inventory.product-stock.get`; add `inventory.stock.receive`, `inventory.stock.adjust`, `inventory.stock.query-availability`, `inventory.stock-locations.list`, `inventory.stock.received`, `inventory.stock.adjusted`, `inventory.stock-level.initialized`; mark `inventory.order.confirm` as "deprecation handler; reshaped in epic-07 for the Reservation flow"; mark `catalog.variant.created` as "consumed by inventory's auto-init use case".
  - **Shared Libraries → cache** — `INVENTORY_STOCK_KEY_VERSION='v2'` (was `'v1'`); the legacy invalidate-only prefix entry (`inventoryStockV1LegacyPrefix`).
  - **Operational notes** — bullet on cache-aside read path is updated to reflect the new key shape; bullet on the auto-init lazy-recovery scenario; bullet on the `CACHE_DRAIN_LEGACY_ON_BOOT` env flag (with the "remove after two deploy epochs" note).
- Append the closing snapshot to `docs/implementation/epic-04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md`. Target ~30 additional lines. Heading: `## Cumulative "after" snapshot`. Subsections:
  1. **Before vs after** in tabular form: list the four old tables + their column counts, then the two new tables + their column counts.
  2. **Mermaid (or ASCII) diagram** of the new schema: two boxes (`stock_location`, `stock_level`), one arrow from `stock_level.stock_location_id` to `stock_location.id`. The cross-service `variant_id` arrow points off-diagram with a `(see epic-02)` label.
  3. **Variant-id-keyed surfaces.** A single bullet list naming every surface that switched from `productId` to `variantId` keying: the DB column, the cache key, the HTTP path (`/api/inventory/variants/:variantId/stock`), the RMQ payload field for the four `inventory.stock.*` routing keys.

**Out:**

- Net-new code in `apps/`/`libs/` — none.
- New routing keys, new events, new use cases — none.
- The audit-log consumer — that's `epic-11`.

## Files to add

- `scripts/seeds/stock-levels.sql`
- `test/inventory-receive-and-adjust.e2e-spec.ts`
- `test/inventory-cache.e2e-spec.ts`

## Files to modify

- `scripts/test-db-seed.ts` — extend with `seedStockLevels` step.
- `scripts/utils/test-db-seed.util.ts` (or wherever the seed-file list lives) — add `stock-levels.sql` to the `TestDbSeedUtil.seedFiles` array.
- `README.md` — System diagram + API → Stock + Caching → Cache key + Database sections.
- `CLAUDE.md` — Stock module file-listing + Message patterns + Shared Libraries → cache + Operational notes.
- `spec/architecture-lint.spec.ts` — inventory fixtures updated per above.
- `docs/implementation/epic-04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md` — closing append.

## Files to delete

None. (The deletions were carried out by tasks 01 / 05 / 06 / 09.)

## Tests

- `yarn test:e2e` runs both new specs. The variant-create step assumes epic-02's API is up; if the project's e2e harness doesn't bootstrap catalog-microservice automatically, the spec uses the test seed (which inserts the variants directly via SQL) as a fallback and skips the variant-create step. The skip-when-catalog-down branch is annotated; the doc deliverable explains.
- `yarn test:unit` continues to pass — no unit specs are added in this task; the arch-lint fixtures run inside `yarn test:unit` (or `yarn test:lint`, depending on the project's script setup).
- `yarn lint` continues to pass.
- `yarn build` continues to pass.
- Manual smoke: `docker compose up -d && yarn migration:run && yarn test:seed && yarn start:dev` — every service boots; the `GET /api/inventory/variants/1/stock` endpoint returns `levels: [{ quantityOnHand: 100, … }]`.

## Closing doc append

`docs/implementation/epic-04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md` gets the `## Cumulative "after" snapshot` section appended. The introductory half (written in task-01) ends with "task-10 appends the closing snapshot here"; this task fulfills that forward-reference.

Concrete content of the snapshot section:

1. **Before-vs-after table.**
   ```
   | Removed                  | Cols | Replaced by              | Cols |
   |--------------------------|------|--------------------------|------|
   | product (inv-side stub)  |  4   | — (lives in catalog)     |  —   |
   | product_stock            |  7   | stock_level              | 10   |
   | product_stock_action     |  4   | — (no longer needed)     |  —   |
   | storage                  |  4   | stock_location           |  9   |
   ```
2. **Schema diagram.**
   ```
   ┌──────────────────┐         ┌────────────────────────────┐
   │ stock_location   │         │ stock_level                │
   ├──────────────────┤         ├────────────────────────────┤
   │ id (PK, VARCHAR) │◄────────┤ stock_location_id (FK)     │
   │ code (UQ)        │         │ variant_id   (FK→catalog)  │
   │ type             │         │ quantity_on_hand           │
   │ address (JSON)   │         │ quantity_allocated         │
   │ gln              │         │ quantity_reserved          │
   │ active           │         │ version (@VersionColumn)   │
   │ created_at       │         │ created_at, updated_at     │
   │ updated_at       │         │ id (PK, BIGINT)            │
   └──────────────────┘         └────────────────────────────┘

   UQ on stock_level: (variant_id, stock_location_id)
   IDX on stock_level: (stock_location_id)
   CHECK (MySQL 8): quantity_on_hand >= 0, …_allocated >= 0, …_reserved >= 0
   ```
3. **Variant-id-keyed surfaces.**
   - `stock_level.variant_id` (DB column).
   - `ris:inventory:stock:v2:<variantId>:<facet>` (cache key — see doc 04).
   - `/api/inventory/variants/:variantId/stock` and its POST siblings (HTTP — see doc 08).
   - `IInventoryStockReceivedEvent.variantId` + `IInventoryStockAdjustedEvent.variantId` + `IInventoryStockLevelInitializedEvent.variantId` + `IInventoryStockLowEvent.variantId` (RMQ — see doc 05 / 06 appendices).

## Exit criteria

The epic's exit criteria (cumulative, from the epic frontmatter) all hold:

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; ≥7 inventory spec files green (the count from the epic charter + the cache spec + the new list-locations spec from task-09).
- [ ] `yarn test:e2e` passes; both new specs green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean. `\d stock_location` and `\d stock_level` show the new tables; `SELECT * FROM stock_location` returns the seeded `default-warehouse`.
- [ ] Every request in `http/inventory.http` executes; `http/product.http` is gone.
- [ ] After `yarn test:seed`, `GET /api/inventory/variants/1/stock` returns `{ levels: [{ quantityOnHand: 100, … }] }`.
- [ ] Redis: keys observed via `redis-cli --scan --pattern 'ris:inventory:stock:v2:*'` match the new shape; no `v1`-prefixed keys are written on the new code path.
- [ ] Creating a new Variant via the catalog flow results in a `StockLevel = 0` row at `default-warehouse` within seconds (covered by the first e2e spec).
- [ ] Per-task docs present under `docs/implementation/epic-04-inventory-stock-level-and-location/` — eight `*.md` files: `01-old-tables-dropped-and-new-schema.md`, `02-default-stocklocation-auto-provision.md`, `03-stocklevel-aggregate-and-version-column.md`, `04-cache-key-bump-v1-to-v2.md`, `05-auto-init-on-variant-created.md`, `06-receive-and-adjust-use-cases.md`, `07-availability-read-path.md`, `08-inventory-http-file.md`.
- [ ] `README.md` System diagram + API + Caching + Database sections updated.
- [ ] `CLAUDE.md` Stock module + Message patterns + cache notes updated.
- [ ] `grep -rn "tmp/" docs apps libs http README.md CLAUDE.md` returns zero hits.
- [ ] The `epic-04` directory under `docs/implementation/` is the final artifact alongside `epic-01-…/`, `epic-02-…/`, and `epic-03-…/`.
