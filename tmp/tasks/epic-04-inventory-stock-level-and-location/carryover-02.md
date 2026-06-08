# Carryover 02 — Inventory read path: contracts, cache v2, Query Availability + List Locations RPCs

> Read this before starting task-03 (after `carryover-01.md`). It records the
> on-disk state task-02 left behind. (This file lives under `tmp/`; the
> self-containment rule does not apply here.)

## Entry state for task-03

- **Contract DTOs** live in a new `libs/contracts/inventory/stock/` sub-area
  (barrelled from `libs/contracts/inventory/index.ts`):
  - `IVariantStockGetPayload` (RPC payload): `{ variantId: number;
    stockLocationIds?: string[]; correlationId?: string }`.
  - `IStockLocationsListPayload` (RPC payload): `{ activeOnly?: boolean;
    correlationId?: string }`.
  - `StockLevelView` (class, `@ApiResponseProperty`): `{ stockLocationId: string;
    quantityOnHand: number; quantityAllocated: number; quantityReserved: number;
    available: number; version: number; updatedAt: Date | null }`.
  - `VariantStockView` (class — **the cached value + the `inventory.stock-level.get`
    response**): `{ variantId: number; totalOnHand: number; totalAvailable: number;
    locations: StockLevelView[] }`.
  - `StockLocationView` (class — the `inventory.location.list` element): `{ id: string;
    name: string; code: string; type: string; gln: string | null; active: boolean }`
    (`address` deliberately omitted from the view for now).
  - The payload interfaces do **not** extend `ICorrelationPayload` (that requires
    a non-optional `correlationId`; the wire contract wants it optional).
  - These replace the deleted `ProductStockGetResponseDto` (gone since task-01).

- **Cache key bumped `v1 → v2`** in `libs/cache/cache-keys.ts`:
  - `INVENTORY_STOCK_KEY_VERSION = 'v2'`.
  - `inventoryStockPrefix(variantId, opts?)` / `inventoryStock(variantId,
    stockLocationIds?, opts?)` now key on **`variantId`** + a sorted
    (`localeCompare`) stock-location facet (`__all__` sentinel when unscoped).
    Shape: `ris:[t:<tenantId>:]inventory:stock:v2:<variantId>:<facet>`.
  - **New invalidate-only legacy builder** `inventoryStockLegacyPrefixV1(id) →
    'ris:inventory:stock:v1:<id>:'`. The two older legacy builders are unchanged:
    `inventoryStockLegacyPrefix(id) → 'ris:inventory:stock:<id>:'` (pre-v1) and
    `productStockPrefix(id) → 'stock:<id>:'` (pre-ADR-016). **Four** stock key
    families now coexist; the top-of-file comment block documents all four.
  - `RETAIL_ORDER_KEY_VERSION` / `CATALOG_PRODUCT_KEY_VERSION` / the reserved
    `catalogPrice*` builders are **untouched** (still `v1`).
  - `libs/cache/spec/cache-keys.spec.ts` updated: asserts the `v2`/`variantId`
    literals, the new `inventoryStockLegacyPrefixV1` literal, and the unchanged
    pre-v1 / pre-ADR-016 / retail / catalog blocks.

- **`IStockCachePort` + `StockCache` rebuilt** on the new payload:
  - Port at `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
    (re-exported from `application/ports/index.ts`; symbol `STOCK_CACHE`).
  - `IStockCacheGetPayload` / `IStockCacheSetPayload`: `{ variantId: number;
    stockLocationIds?: string[]; tenantId?: string; correlationId?: string }`
    (+ `data: VariantStockView` on set).
  - `IStockCacheInvalidateItem`: `{ variantId: number; stockLocationId: string }`.
  - `IStockCacheGetResult`: `{ value: VariantStockView | undefined; available: boolean }`
    (CACHE-005 `available` flag kept).
  - Surface: `get` / `set` / `getOrLoad(payload, loader)` /
    `withInvalidation<T>(work, resolveItems, opts?)` — **no public `invalidate`**
    (ADR-023). ±10% TTL jitter on `set`, single-flight composition on `getOrLoad`
    (ADR-021) carried over from the deleted adapter.
  - `withInvalidation` fans out **four** `delByPrefix` per unique `variantId`:
    current v2 (`inventoryStockPrefix`, tenanted), pre-v2 v1
    (`inventoryStockLegacyPrefixV1`), pre-v1 (`inventoryStockLegacyPrefix`), and
    pre-ADR-016 (`productStockPrefix`). The three legacy wipes are unconditionally
    single-tenant.
  - Adapter at `infrastructure/cache/stock.cache.ts` (+ `infrastructure/cache/index.ts`,
    + `infrastructure/cache/spec/stock.cache.spec.ts`).

- **Two new read use cases** at `apps/inventory-microservice/src/modules/stock/application/use-cases/`
  (barrelled from `use-cases/index.ts`):
  - `QueryAvailabilityUseCase` — input `IVariantStockGetPayload`, output
    `VariantStockView`. Cache-aside via `stockCache.getOrLoad`; loader calls
    `repo.findStockLevelsByVariant(variantId, stockLocationIds)`, maps each row to
    a `StockLevelView` (`available` = the domain getter), sorts by
    `stockLocationId` (`localeCompare`, deterministic cached value), and sums
    `totalOnHand` / `totalAvailable`. An empty result is a valid cached value
    (`locations: []`, totals `0`). No skip-cache branch (no transactional read
    path here).
  - `ListLocationsUseCase` — input `IStockLocationsListPayload`, output
    `StockLocationView[]` via `repo.listLocations(activeOnly)`. Not cached.
  - Fresh test doubles at `use-cases/spec/test-doubles.ts`
    (`InMemoryStockRepository`, `InMemoryStockCache` with an `available` toggle
    + a `seed` helper).

- **`StockController`** (`presentation/stock.controller.ts`) now has **three**
  `@MessagePattern` handlers:
  - `INVENTORY_STOCK_LEVEL_GET` → `QueryAvailabilityUseCase` (`handleStockLevelGet`).
  - `INVENTORY_LOCATION_LIST` → `ListLocationsUseCase` (`handleLocationList`).
  - `INVENTORY_ORDER_CONFIRM` → the kept deprecation stub (`handleOrderConfirm`,
    typed `RpcException`).

- **Routing keys** added to `libs/messaging/routing-keys.constants.ts`,
  mirrored value-for-value in
  `libs/contracts/microservices/microservice-message-pattern.enum.ts`, and
  asserted in `libs/messaging/spec/routing-keys.constants.spec.ts`:
  - `INVENTORY_STOCK_LEVEL_GET: 'inventory.stock-level.get'`
  - `INVENTORY_LOCATION_LIST: 'inventory.location.list'`

- **`StockModule`** (`infrastructure/stock.module.ts`) provider set:
  `StockTypeormRepository` (+ `STOCK_REPOSITORY`), **`StockCache` (+ `STOCK_CACHE`)**,
  `StockRabbitmqPublisher` (+ `STOCK_EVENTS_PUBLISHER`), `TypeormTransactionAdapter`
  (+ `TRANSACTION_PORT`), **`QueryAvailabilityUseCase`**, **`ListLocationsUseCase`**.
  Imports `DatabaseModule.forFeature([StockLocationEntity, StockLevelEntity])` +
  `MicroserviceClientNotificationModule`. The inventory `app.module.ts` already
  imports the global `CacheModule` (now actually consumed by `StockCache`) and
  `ConfigModule` (global) — DI resolves cleanly (verified by the e2e boot).

## Key decisions & deviations

- **Cache TTL env was NOT renamed.** `StockCache` still reads
  `CACHE_TTL_MS_PRODUCT_STOCK` (Joi default 60000ms). It now governs the
  variant-availability cache; the name was kept to avoid churning `libs/config`
  Joi + the README env table + docker/.env. (The task offered a rename as
  optional; the no-rename path was taken.) `libs/config` / README env table
  unchanged.
- **`VariantStockView` / `StockLevelView` / `StockLocationView` are classes**
  with `@ApiResponseProperty` (the `PriceView` precedent), so task-03's gateway
  can declare them as `@ApiOkResponse({ type: … })`. The use cases build plain
  object literals typed as these classes (structural typing — the catalog
  view-factory pattern).
- **`QueryAvailabilityUseCase` sorts `locations` by `stockLocationId`** so the
  cached value is deterministic for a given DB state (the repository `find` does
  not order). This makes the task-03 availability e2e stable.
- **No ADR** for this task (the bump follows ADR-022; the model follows ADR-027).
  Implementation doc written: `docs/implementation/04-inventory-stock-level-and-location/04-cache-key-bump-v1-to-v2.md`
  (cross-links ADR-022 and the not-yet-written sibling `07-availability-read-path.md`).
- **CLAUDE.md got surgical edits** (the precedent task-01 set): the inventory
  message-pattern bullet now lists the two read RPCs; the contracts inventory
  sub-area lists the new `stock/` DTOs; the cache-key convention paragraph
  reflects `v2`/`variantId` + the four-prefix fan-out. **README.md was NOT
  touched** — see gaps below.

## Known gaps / deferrals

- **Gateway inventory endpoints + `http/inventory.http` + stock-level seed +
  the availability e2e → task-03.** The two RPCs have **no gateway caller yet**;
  they are reachable only directly over RMQ today. No HTTP route was added, so no
  `http/*.http` file was needed this task.
- **`variant.created` auto-init consumer → task-04.**
- **Receive / Adjust write operations + their `withInvalidation` callers +
  `inventory.stock.low` wiring → task-05.** `withInvalidation` itself ships now
  (built here, unused on the read path — reads never mutate).
- **Full inventory rewrite of `README.md` (the "Caching" section, lines ~682–779,
  still describes the old `v1`/`productId`/`GetStockUseCase`/`SUM` model behind
  its status disclaimer) and the `CLAUDE.md` inventory module bullet (the
  superseded `StockItem`/`product_stock` bullet, behind its disclaimer) →
  task-06.** Only surgical CLAUDE.md edits were made this task.
- **`ProductStockActionEnum`** (in `libs/contracts/inventory/product-stock/product-stock.types.ts`)
  is still dead exported code (inherited from task-01).
- **Reservation/allocation + no-oversell enforcement of `version` → a later
  inventory-reservation capability.**

## How to verify (all run green this session)

```bash
yarn lint                 # exit 0 (--max-warnings 0)
yarn test:unit            # 67 suites, 478 tests pass (was 64/445 in task-01; +3 suites: stock.cache, query-availability, list-locations)
yarn build                # all 5 apps compile
yarn test:e2e             # reload + seed + 7 suites / 82 tests pass (unchanged from task-01 — no gateway wiring yet)
grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md   # CLEAN (exit 1)
# key-shape spot check:
#   CACHE_KEYS.inventoryStock(42)            → 'ris:inventory:stock:v2:42:__all__'
#   CACHE_KEYS.inventoryStockLegacyPrefixV1(42) → 'ris:inventory:stock:v1:42:'
# boot check: the e2e boots the inventory microservice with StockCache + the two
#   read handlers wired (DI resolves the global CacheModule's CACHE_PORT cleanly).
```
