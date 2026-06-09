---
epic: epic-04
task_number: 1
title: Drop the legacy inventory model; new StockLocation + StockLevel foundation
depends_on: []
doc_deliverable: docs/implementation/04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md
adr_deliverable: docs/adr/027-stocklevel-running-totals-and-stocklocation.md
---

# Task 01 — Drop the legacy inventory model; new StockLocation + StockLevel foundation

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-012** (the `StockItem` / `product_stock` model you are
superseding — read it to know exactly what is being replaced), **ADR-004**
(domain is framework-free — no `@nestjs/*`, no `typeorm`, no `class-validator` on
the model), **ADR-005 / ADR-019** (extend `BaseEntity`; `SnakeNamingStrategy`;
hand-authored migration with working `up`/`down`; `synchronize` stays off),
**ADR-017** (the boundaries lint; the application/port layer returns domain types
only — no TypeORM leak), **ADR-025** (the `variantId`-is-the-backbone convention
and the repository-level-uniqueness pattern), and **ADR-003** (you are authoring
**ADR-027** and flipping ADR-012's status).

## Goal

Remove the entire legacy inventory model and stand up the new persistence
foundation in one clean cut, leaving the monorepo green (compiles, lints, unit +
e2e pass) with a **bootable but operation-free** inventory microservice. The
append-only `product_stock` ledger, the `product_stock_action` lookup, and the
`storage` table are dropped and replaced by `stock_location` (one auto-provisioned
default warehouse) + `stock_level` (per-location running totals with a `version`
optimistic-concurrency column). All keys move from `productId` to `variantId`.
The new `StockLocation` and `StockLevel` domain models, their entities + mappers,
and the rewritten `IStockRepositoryPort` + `StockTypeormRepository` land here; the
read/write **operations**, the gateway, and the cache rebuild land in later tasks.

This is the **cleanup-first task**. Every obsolete artifact listed under *Files to
delete* is **removed outright** (never renamed to `legacy`/`old`/`_v1`/`_bak`),
and every dangling reference is fixed or deleted in this same session.

## Entry state assumed

- `epic-02` (catalog) and `epic-03` (pricing) are complete. The catalog
  microservice owns `product` + `product_variant`; the colocated pricing module
  owns `price` + `tax_category`. The inventory-side `product` stub was already
  removed by epic-02; this task does **not** touch it.
- The inventory microservice (`apps/inventory-microservice/`) runs the legacy
  `stock` module: `StockItem` / `Storage` domain models, `product_stock` /
  `product_stock_action` / `storage` entities, `add-stock` / `get-stock` /
  `reserve-stock-for-order` use cases, a `StockCache`, a `StockController`
  handling `inventory.product-stock.get` + `inventory.order.confirm`, and a
  `StockRabbitmqPublisher`.
- The API gateway runs `apps/api-gateway/src/modules/inventory/` exposing
  `GET /api/product/:productId/stock` (`ProductController`, gated `@Roles(ADMIN)`),
  proxying `inventory.product-stock.get`.
- The retail microservice's `InventoryConfirmRabbitmqAdapter` sends
  `inventory.order.confirm` with `IProductStockOrderConfirmPayload`.
- `test/system-api.e2e-spec.ts` exercises `GET /api/product/:productId/stock`,
  `POST /api/order`, and `PUT /api/order/:id/confirm` (the confirm→reserve→stock
  flow). `test/auth.e2e-spec.ts` uses `GET /api/product/1/stock` as a sample
  protected route (401 without token; 200 with admin token).
- `PermissionCodeEnum` already contains `INVENTORY_READ = 'inventory:read'` and
  `INVENTORY_ADJUST = 'inventory:adjust'`, both already in `PERMISSION_SEEDS` and
  bound to the `warehouse-staff` role. **No permission-registry change is needed.**
- `scripts/utils/test-db-seed.util.ts` lists `'product-stock.sql'` first in
  `seedFiles`. `scripts/seeds/product-stock.sql` seeds the `product_stock` table.
- Latest migration: `migrations/1780546069117-CreatePricingTables.ts`. The
  migration data-source globs `migrations/*{.ts,.js}`.

## Scope

**In**
- Drop `product_stock`, `product_stock_action`, `storage` via one migration that
  also creates `stock_location` + `stock_level` and auto-provisions
  `default-warehouse`.
- New `StockLocation` + `StockLevel` domain models (+ specs); new entities +
  mappers; rewritten `IStockRepositoryPort` + `StockTypeormRepository`; updated
  `stockEntities` barrel.
- Reduce `StockController` to the `inventory.order.confirm` deprecation-error stub
  (keep that routing key + contract); delete the `inventory.product-stock.get`
  handler and routing key.
- Delete the entire gateway `modules/inventory/` and unregister it from the
  gateway `AppModule`.
- Delete the `ProductStockGetResponseDto` read contract; keep
  `IProductStockOrderConfirmPayload`. Replace `INVENTORY_DEFAULT_STORAGE` with
  `INVENTORY_DEFAULT_STOCK_LOCATION = 'default-warehouse'`.
- Fix the dangling e2e references (`system-api`, `auth`); delete `http/product.http`;
  delete `scripts/seeds/product-stock.sql` + drop it from `seedFiles`.
- Record **ADR-027**; flip ADR-012's status. Write docs `01`, `02`, `03`.

**Out**
- Any inventory **operation** — Query Availability, List Locations, Receive,
  Adjust (tasks 02 / 05). This task leaves the service with only the confirm
  deprecation stub.
- The cache `v1 → v2` bump + `StockCache` rebuild (task 02).
- The gateway rebuild + new HTTP file + stock-level seed (task 03).
- The variant-created consumer (task 04). Reservation/allocation/StockMovement
  (owned by a later inventory-reservation capability).

## New domain model specifics

**`StockLocation`** (framework-free; `apps/.../stock/domain/stock-location.model.ts`):
- Fields: `id: string` (e.g. `default-warehouse`), `name: string`,
  `code: string`, `type: StockLocationTypeEnum`, `address: Record<string, unknown> | null`,
  `gln: string | null`, `active: boolean`, `createdAt?: Date`, `updatedAt?: Date`.
- `StockLocationTypeEnum` (domain enum, suffix `*Enum` per ADR-004):
  `WAREHOUSE = 'warehouse'`, `STORE = 'store'`, `DROPSHIP_VIRTUAL = 'dropship-virtual'`.
- Invariants (throw a plain `Error` for now — inventory has no `DomainException`
  subclass yet; keep it consistent with the pre-existing stock domain style):
  `id`/`name`/`code` non-empty; `gln` (when present) matches `^\d{13}$`.
- `code` global uniqueness is **repository-level** (UNIQUE constraint), not
  model-enforced (mirror ADR-025's `slug`/`sku` convention).
- A `deactivate()` helper sets `active = false` (soft-delete is via the `active`
  flag — **never** a `deletedAt` timestamp; the inherited `BaseEntity.deletedAt`
  stays inert, as on the catalog tables).

**`StockLevel`** (framework-free; `apps/.../stock/domain/stock-level.model.ts`):
- Fields: `id: number | null`, `variantId: number` (opaque cross-service link —
  **never** import the catalog `ProductVariant`; the coupling is the FK in
  persistence, per ADR-004/ADR-017), `stockLocationId: string`,
  `quantityOnHand: number`, `quantityAllocated: number`, `quantityReserved: number`,
  `version: number`, `updatedAt?: Date | null`.
- Invariants: all three quantities are integers `≥ 0`; `version` integer `≥ 0`.
- `get available(): number` → `quantityOnHand − quantityAllocated − quantityReserved`.
- `changeOnHand(delta: number): void` — the **only** mutation this epic needs:
  applies a signed delta to `quantityOnHand`, rejects a result `< 0` (throw
  `Error`), and **increments `version`** (so "version bumps on every mutation" is
  observable in the unit spec). Do **not** add `allocate` / `reserve` / `release`
  methods — those belong to the later inventory-reservation capability; shipping
  them now would be dead, untested code.
- A `static initialAt(variantId, stockLocationId)` factory returning a
  `StockLevel` with all quantities `0` and `version 0` (used by the auto-init
  consumer + lazy-init in later tasks).

> **Why `version` ships now even though nothing enforces it yet:** the no-oversell
> invariant (reservation/allocation) arrives with the later inventory-reservation
> capability and is hardened later still. Shipping the `version` column +
> `@VersionColumn()` from the start makes that optimistic-concurrency retrofit
> non-destructive (no future `ALTER TABLE` on a populated table). Document this in
> doc `03`.

## Repository port (rewrite)

`IStockRepositoryPort` (`STOCK_REPOSITORY` symbol stays) — domain types only, no
`typeorm` import (ADR-017). Replace the old product-stock methods with:

```ts
findLocation(id: string): Promise<StockLocation | null>;
listLocations(activeOnly?: boolean): Promise<StockLocation[]>;
findStockLevel(variantId: number, stockLocationId: string): Promise<StockLevel | null>;
findStockLevelsByVariant(variantId: number, stockLocationIds?: string[]): Promise<StockLevel[]>;
saveStockLevel(stockLevel: StockLevel): Promise<StockLevel>; // upsert; re-reads for the concrete id
```

Implement all five in `StockTypeormRepository` (the only `@InjectRepository`
site). `saveStockLevel` re-reads the saved row so the generated id comes back
concrete (the "re-read the saved graph" idiom `CatalogTypeormRepository` uses).
Later tasks consume these methods; this task only needs them to compile and a
(recommended) repository spec to be green.

## Persistence specifics

`StockLocationEntity` / `StockLevelEntity` extend `BaseEntity`. **Important
divergence from `BaseEntity`'s auto-increment integer PK:** `stock_location.id`
is a caller-assigned `VARCHAR(64)` string PK (`default-warehouse`), so override
the PK column on `StockLocationEntity` to a string primary column (do **not** use
the inherited auto-increment `id`). `StockLevelEntity` keeps a generated numeric
PK (`BIGINT`). Map `variant_id` as a **plain `BIGINT` scalar with no
`@ManyToOne`** (opaque link, ADR-026 precedent). `version` uses TypeORM
`@VersionColumn()`. Fields are camelCase; `SnakeNamingStrategy` maps to
snake_case. `deletedAt` stays inert on both tables.

### Migration (`yarn migration:create`)

One migration, e.g. `…-ReplaceProductStockWithStockLevelAndLocation`, with a
working `up`/`down` (`synchronize` stays off):

```sql
-- up
DROP TABLE IF EXISTS product_stock;          -- old delta ledger
DROP TABLE IF EXISTS product_stock_action;   -- old lookup
DROP TABLE IF EXISTS storage;                 -- replaced by stock_location

CREATE TABLE stock_location (
  id          VARCHAR(64)  NOT NULL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  code        VARCHAR(64)  NOT NULL,
  type        ENUM('warehouse','store','dropship-virtual') NOT NULL DEFAULT 'warehouse',
  address     JSON NULL,
  gln         VARCHAR(13) NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  TIMESTAMP NULL,
  CONSTRAINT UC_STOCK_LOCATION_CODE UNIQUE (code)
);

CREATE TABLE stock_level (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  variant_id         BIGINT UNSIGNED NOT NULL,
  stock_location_id  VARCHAR(64) NOT NULL,
  quantity_on_hand   INT NOT NULL DEFAULT 0,
  quantity_allocated INT NOT NULL DEFAULT 0,
  quantity_reserved  INT NOT NULL DEFAULT 0,
  version            INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at         TIMESTAMP NULL,
  CONSTRAINT UC_STOCK_LEVEL_VARIANT_LOCATION UNIQUE (variant_id, stock_location_id),
  CONSTRAINT FK_STOCK_LEVEL_LOCATION FOREIGN KEY (stock_location_id)
    REFERENCES stock_location (id) ON DELETE RESTRICT,
  CONSTRAINT FK_STOCK_LEVEL_VARIANT FOREIGN KEY (variant_id)
    REFERENCES product_variant (id) ON DELETE RESTRICT,
  CONSTRAINT CK_STOCK_LEVEL_ON_HAND   CHECK (quantity_on_hand   >= 0),
  CONSTRAINT CK_STOCK_LEVEL_ALLOCATED CHECK (quantity_allocated >= 0),
  CONSTRAINT CK_STOCK_LEVEL_RESERVED  CHECK (quantity_reserved  >= 0)
);
CREATE INDEX IDX_STOCK_LEVEL_LOCATION ON stock_level (stock_location_id);

-- Q8: exactly one default StockLocation, idempotently provisioned.
INSERT INTO stock_location (id, name, code, type, active)
VALUES ('default-warehouse', 'Default Warehouse', 'default-warehouse', 'warehouse', TRUE)
ON DUPLICATE KEY UPDATE id = id;
```

- The `variant_id → product_variant.id` FK is a real cross-service FK (both tables
  share the one MySQL connection). Integrity is also enforced at the application
  layer + the auto-init consumer (a later task).
- If the running MySQL version rejects `CHECK` constraints, enforce non-negativity
  only in the aggregate + use cases and note the omission in doc `03`.
- `down` reverses in dependency order: `DROP TABLE stock_level;`,
  `DROP TABLE stock_location;`, then **recreate** `product_stock`,
  `product_stock_action`, and `storage` with their original columns (copy the
  `CREATE TABLE` shapes from `migrations/1772600000000-InitStarterEntities.ts` and
  `migrations/1774134626155-AddOrderProductIdToProductStock.ts`) so a
  `migration:revert` returns the schema to its pre-task state cleanly.

## Controller reduction — keep the confirm deprecation stub

Rewrite `apps/.../stock/presentation/stock.controller.ts` to hold **only** the
`inventory.order.confirm` handler, reshaped to throw a typed `RpcException`
(message names it as a deprecated seam — phrase it by capability, e.g.
`'inventory.order.confirm is deprecated; reservation is handled by the
inventory-reservation capability'`; **no** "epic"/"task" wording). Keep its
`@Payload() payload: IProductStockOrderConfirmPayload` signature so the retail
adapter's compile-time contract still holds (ADR-013 §7). Delete the
`inventory.product-stock.get` handler. The controller injects no use cases.

> This keeps the retail confirm flow resolving to an explicit error rather than an
> RPC timeout. The whole confirm seam is removed by the later
> inventory-reservation capability.

## Files to add

- `apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts`
- `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts`
- `apps/inventory-microservice/src/modules/stock/domain/spec/stock-location.model.spec.ts`
- `apps/inventory-microservice/src/modules/stock/domain/spec/stock-level.model.spec.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-location.entity.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-level.entity.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-location.mapper.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-level.mapper.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/spec/stock-typeorm.repository.spec.ts` (rewrite/replace the old one — see deletions)
- `migrations/<timestamp>-ReplaceProductStockWithStockLevelAndLocation.ts`
- `docs/adr/027-stocklevel-running-totals-and-stocklocation.md`
- `docs/implementation/04-inventory-stock-level-and-location/01-old-tables-dropped-and-new-schema.md`
- `docs/implementation/04-inventory-stock-level-and-location/02-default-stocklocation-auto-provision.md`
- `docs/implementation/04-inventory-stock-level-and-location/03-stocklevel-aggregate-and-version-column.md`

## Files to modify

- `apps/.../stock/domain/index.ts` — barrel the new models + enum; drop the
  `stock-item.model` / `storage.model` exports (keep the `events` re-export).
- `apps/.../stock/application/ports/stock.repository.port.ts` — rewrite to the new
  domain-typed methods (above); `apps/.../application/ports/index.ts` —
  **remove** the `stock-cache.port` re-export (the cache + port are deleted here;
  task 02 re-adds them). Keep `STOCK_EVENTS_PUBLISHER`, `TRANSACTION_PORT`,
  `STOCK_REPOSITORY`.
- `apps/.../stock/infrastructure/persistence/index.ts` — set
  `stockEntities = [StockLocationEntity, StockLevelEntity]`; export the new
  entities, mappers, the rewritten repository, and keep the transaction adapter.
- `apps/.../stock/infrastructure/persistence/stock-typeorm.repository.ts` —
  rewrite against the new entities/mappers/port.
- `apps/.../stock/infrastructure/stock.module.ts` — `DatabaseModule.forFeature([
  StockLocationEntity, StockLevelEntity])`; drop the deleted use cases, the
  `StockCache` + `STOCK_CACHE` provider, and the `STOCK_CACHE` import; keep
  `StockTypeormRepository`/`STOCK_REPOSITORY`, the publisher/`STOCK_EVENTS_PUBLISHER`,
  the transaction adapter/`TRANSACTION_PORT`, and `StockController`.
- `apps/.../stock/presentation/stock.controller.ts` — reduce to the confirm stub.
- `apps/api-gateway/src/app/app.module.ts` — remove the `InventoryModule` import
  + its `imports[]` entry.
- `libs/contracts/inventory/inventory.constants.ts` — replace
  `INVENTORY_DEFAULT_STORAGE` with `INVENTORY_DEFAULT_STOCK_LOCATION =
  'default-warehouse'`; keep `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`.
- `libs/contracts/inventory/index.ts` + `.../product-stock/index.ts` +
  `.../product-stock/product-stock-get/index.ts` — drop the `*Get*` DTO/type
  exports; keep the `*OrderConfirm*` exports.
- `libs/messaging/routing-keys.constants.ts` — remove
  `INVENTORY_PRODUCT_STOCK_GET`; keep `INVENTORY_ORDER_CONFIRM` +
  `INVENTORY_STOCK_LOW`. Update `libs/messaging/spec/routing-keys.constants.spec.ts`.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — remove the
  matching legacy `INVENTORY_PRODUCT_STOCK_GET` entry so the value-for-value
  agreement spec stays green.
- `scripts/utils/test-db-seed.util.ts` — remove `'product-stock.sql'` from
  `seedFiles`.
- `test/system-api.e2e-spec.ts` — delete the `describe('Product', …)` block (old
  `GET /api/product/:productId/stock`) and its cache helpers; in the
  `describe('Order', …)` block keep the `POST /api/order` create/validation tests
  and **remove** the `PUT /api/order/:id/confirm` stock-outcome assertions (the
  reservation flow is reshaped by the later inventory-reservation capability).
  Remove the now-unused `ProductStockGetResponseDto` / `CACHE_KEYS.inventoryStock`
  imports. (If trimming proves entangled, deleting the whole spec is acceptable —
  record the choice in the carryover.)
- `test/auth.e2e-spec.ts` — repoint the two `/api/product/1/stock` references to a
  still-existing protected route (recommended `GET /api/auth/me`), preserving the
  401-without-token and 200-with-token assertions.
- `CLAUDE.md` / `README.md` — only the lines that name the now-deleted
  `GET /api/product/:productId/stock` route and the `inventory.product-stock.get`
  RPC (so no deliverable describes a route that no longer exists). The full
  inventory rewrite of these files is task-06; keep this edit minimal.

## Files to delete

- `apps/.../stock/domain/stock-item.model.ts`
- `apps/.../stock/domain/storage.model.ts`
- `apps/.../stock/domain/spec/stock-item.model.spec.ts`
- `apps/.../stock/domain/spec/storage.model.spec.ts`
- `apps/.../stock/infrastructure/persistence/product-stock.entity.ts`
- `apps/.../stock/infrastructure/persistence/product-stock-action.entity.ts`
- `apps/.../stock/infrastructure/persistence/storage.entity.ts`
- `apps/.../stock/infrastructure/persistence/stock-item.mapper.ts`
- `apps/.../stock/infrastructure/persistence/spec/stock-typeorm.repository.spec.ts` (old; replaced)
- `apps/.../stock/application/use-cases/add-stock.use-case.ts` (+ `spec/add-stock.use-case.spec.ts`)
- `apps/.../stock/application/use-cases/get-stock.use-case.ts` (+ `spec/get-stock.use-case.spec.ts`)
- `apps/.../stock/application/use-cases/reserve-stock-for-order.use-case.ts` (+ `spec/reserve-stock-for-order.use-case.spec.ts`)
- `apps/.../stock/application/use-cases/spec/test-doubles.ts` (references deleted types; task 02 adds fresh doubles)
- `apps/.../stock/application/use-cases/index.ts` (empty barrel — delete or leave a no-op barrel; task 02 repopulates)
- `apps/.../stock/infrastructure/cache/stock.cache.ts` (+ `spec/stock.cache.spec.ts`, + `cache/index.ts`)
- `apps/.../stock/application/ports/stock-cache.port.ts`
- The entire gateway `apps/api-gateway/src/modules/inventory/` tree
  (`application/ports/*`, `application/use-cases/*`, `infrastructure/messaging/*`,
  `presentation/*` incl. `product.controller.ts` + `dto/`, `inventory.module.ts`,
  `index.ts`).
- `libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.response.dto.ts`
- `libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.types.ts`
- `libs/contracts/inventory/product-stock/product-stock-get/index.ts`
- `http/product.http`
- `scripts/seeds/product-stock.sql`

> Keep `apps/.../stock/domain/events/*` (the `StockLow`/`StockReserved`/`StockReleased`
> event files) and `apps/.../stock/infrastructure/messaging/stock-rabbitmq.publisher.ts`
> + `STOCK_EVENTS_PUBLISHER` — they still compile (they import domain events +
> the `IInventoryStockLowEvent` contract, none of which are deleted here) and are
> reused by later tasks. Keep `typeorm-transaction.adapter.ts` + `TRANSACTION_PORT`.

## Tests

- **Unit** (`yarn test:unit`):
  - `stock-location.model.spec.ts` — `id`/`name`/`code` non-empty; `gln` 13-digit
    shape; `deactivate()` flips `active`; the `type` enum values.
  - `stock-level.model.spec.ts` — non-negative quantities on construction;
    `available = onHand − allocated − reserved`; `changeOnHand` rejects a result
    `< 0`; **`version` increments on every `changeOnHand`**; `initialAt` yields all
    zeros + `version 0`.
  - `stock-typeorm.repository.spec.ts` (recommended) — `saveStockLevel` upserts +
    re-reads for the concrete id; `findStockLevelsByVariant` filters by location.
- **Migration** — `yarn migration:run` applies cleanly on top of the pricing
  schema; `\d`/`SHOW COLUMNS` confirm `stock_location` + `stock_level` (with
  `version`); `SELECT * FROM stock_location` returns `default-warehouse`. Running
  the migration twice (after `migration:revert`) reapplies without error; the
  default-warehouse INSERT is idempotent.
- **E2E** (`yarn test:e2e`) — the trimmed `system-api` + repointed `auth` specs,
  and all other e2e specs, pass with the inventory service offering only the
  confirm deprecation stub.
- **Seed** — `yarn test:seed` runs without `product-stock.sql` and does not error
  (no `product_stock` table remains). Stock-level seed rows arrive in task 03.

## Doc deliverable

Write three docs under
`docs/implementation/04-inventory-stock-level-and-location/`:

`01-old-tables-dropped-and-new-schema.md` — what was deleted (`product_stock`,
`product_stock_action`, `storage`; note the `product` stub was already gone) and
why; what was added (`stock_location`, `stock_level`); the rationale for running
totals over a ledger-as-source-of-truth; the `productId → variantId` keying shift
and the cross-service FK to `product_variant`.

`02-default-stocklocation-auto-provision.md` — the Open Question Q8 decision
(exactly one default location, Vendure-style); the idempotent migration INSERT
(`ON DUPLICATE KEY UPDATE`); why making it optional is a migration hazard; how to
add a second location later (and that multi-location order *routing* stays out).

`03-stocklevel-aggregate-and-version-column.md` — the `StockLevel` aggregate
(`available` getter, `changeOnHand`, non-negative invariants); the `version`
optimistic-concurrency token and why it ships now though enforcement is deferred
to the inventory-reservation + concurrency-hardening capabilities; if `CHECK`
constraints were unavailable, note the aggregate-level fallback.

Cross-link `docs/adr/027-…md` and `docs/adr/012-…md` by relative path. Describe
everything by capability — never by an epic/task number.

## ADR deliverable

`docs/adr/027-stocklevel-running-totals-and-stocklocation.md` (Nygard hybrid:
Status, Context, Decision, Alternatives Considered, Consequences; 3-digit padded;
allocate the number at first commit — if `027` is taken, take the next free
number and record it in the carryover). Decision content:
- Inventory replaces the append-only `product_stock` ledger (source of truth via
  `SUM/GROUP BY`) with per-location **`StockLevel` running totals**
  (`quantityOnHand` / `quantityAllocated` / `quantityReserved`).
- **`StockLocation`** is location-aware at the universal core; exactly one default
  (`default-warehouse`) is auto-provisioned (Q8). Soft-delete via `active`, never
  `deletedAt`.
- A `version` optimistic-concurrency column ships now; the no-oversell invariant
  it guards is enforced by the later inventory-reservation + concurrency
  capabilities.
- All inventory keys move from `productId` to `variantId` (the catalog backbone,
  ADR-025); `stock_level.variant_id` is an opaque FK to `product_variant.id`.
- **Supersedes ADR-012** (`StockItem` / `product_stock`): in ADR-012, flip
  `Status` to `Superseded by ADR-027` + add a one-line pointer (the only edit an
  accepted ADR may receive — ADR-003).
- Note the cache *mechanism* (cache-aside, ADR-002/006/016/021/022/023) is
  preserved; only the cached *value shape* changes (a `StockLevel` projection, not
  a SUM aggregate) — the key-version bump that records it is a later task.
- Alternatives: keep the ledger-as-source (rejected — costly read aggregation,
  no per-location running totals); make the default location optional (rejected —
  migration hazard at the second warehouse); a `deletedAt` soft-delete for
  locations (rejected — `active` is the lifecycle flag).

## Carryover to read

None — first task.

## Carryover to produce

Write `tmp/tasks/epic-04-inventory-stock-level-and-location/carryover-01.md` per
`tmp/tasks/execution-requirements.md` §7. Capture at minimum:
- **Entry state for task-02:** the new schema is live (`stock_location` +
  `stock_level` with `version`, `default-warehouse` provisioned); the new
  `StockLocation` / `StockLevel` models + `StockLevelTypeEnum`; the rewritten
  `IStockRepositoryPort` method signatures + `STOCK_REPOSITORY`; that the inventory
  service exposes **only** the `inventory.order.confirm` deprecation stub; that
  the gateway has **no** inventory module; that `StockCache` + `stock-cache.port`
  were deleted (task 02 rebuilds them) and `cache-keys.ts` is **still `v1`**.
- **Files added / modified / deleted** (concise list).
- **Key decisions:** the ADR number actually allocated for ADR-027; that ADR-012
  is marked superseded; `INVENTORY_DEFAULT_STOCK_LOCATION = 'default-warehouse'`;
  the `stock_location.id` string-PK divergence from `BaseEntity`; the removed
  routing key `inventory.product-stock.get`; the kept confirm stub +
  `IProductStockOrderConfirmPayload`; whether `system-api.e2e` was trimmed or
  deleted; that `auth.e2e` was repointed to `/api/auth/me`.
- **Known gaps / deferrals:** read RPCs + cache `v2` → task-02; gateway endpoints
  + stock-level seed → task-03; auto-init consumer → task-04; Receive/Adjust +
  events + low-stock → task-05; reservation/allocation/StockMovement → a later
  inventory-reservation capability.
- **How to verify:** `yarn lint`, `yarn test:unit`, `yarn test:e2e`, `yarn build`,
  `yarn migration:run` + `yarn migration:revert`, the self-containment grep, and
  `docker compose up -d && yarn migration:run && yarn start:dev` boots inventory.

## Exit criteria

- [ ] `product_stock`, `product_stock_action`, `storage` are dropped;
      `stock_location` + `stock_level` exist with the documented columns, indexes,
      FKs, and the `version` column on `stock_level`; `default-warehouse` is
      auto-provisioned (idempotently).
- [ ] `StockLocation` + `StockLevel` models + specs are green; the repository
      compiles against the rewritten port.
- [ ] The inventory service boots and exposes only the `inventory.order.confirm`
      deprecation stub; the gateway has no inventory module; no dangling import to
      any deleted symbol remains anywhere in the monorepo.
- [ ] `http/product.http`, `scripts/seeds/product-stock.sql`, the old gateway
      `modules/inventory/`, and the old domain/persistence/use-case/cache files
      are gone; nothing was renamed to `legacy`/`old`/`_v1`.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes.
- [ ] `yarn test:e2e` passes (trimmed `system-api` + repointed `auth`).
- [ ] The migration applies and reverts cleanly; re-running after a revert works.
- [ ] ADR-027 is recorded; ADR-012 is marked `Superseded by ADR-027`; docs `01`,
      `02`, `03` are written.
- [ ] The self-containment grep is clean
      (`grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`).
- [ ] `carryover-01.md` is written.
