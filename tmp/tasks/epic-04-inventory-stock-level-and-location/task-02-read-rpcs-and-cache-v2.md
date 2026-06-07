---
epic: epic-04
task_number: 2
title: Inventory-side read path — contracts, cache v2, Query Availability + List Locations RPCs
depends_on: [1]
doc_deliverable: docs/implementation/04-inventory-stock-level-and-location/04-cache-key-bump-v1-to-v2.md
adr_deliverable: none
---

# Task 02 — Inventory-side read path: contracts, cache v2, Query Availability + List Locations RPCs

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-002 / ADR-006** (cache-aside contract — read-through on miss,
write-back, TTL safety net), **ADR-016** (generalized `ris:…` key shape +
`delByPrefix`), **ADR-021** (single-flight + ±10% TTL jitter via
`getOrLoad`/`withInvalidation`), **ADR-022** (per-aggregate cache-key schema
version — you are bumping `INVENTORY_STOCK_KEY_VERSION`), **ADR-023** (post-commit
invalidation enforced by type — `withInvalidation`, no public `invalidate`),
**ADR-004 / ADR-017** (layering + boundaries; the read use case never imports
TypeORM or a transport).

## Goal

Give the inventory microservice its read path on the new model: the contract DTOs
for variant availability + location listing, the `StockCache` rebuilt under a new
`v2` key keyed on `variantId` (the cached value changes shape, hence the bump),
the `QueryAvailabilityUseCase` (cache-aside, per-location + aggregated) and
`ListLocationsUseCase`, and the two new `@MessagePattern` handlers that expose
them. No gateway yet — the new RPCs have no caller until task-03; this task is
green because nothing depends on them and the old gateway is already gone.

## Entry state assumed

- task-01 carryover present. `stock_location` + `stock_level` exist;
  `default-warehouse` is provisioned; `StockLocation` / `StockLevel` models +
  `IStockRepositoryPort` (`findLocation`, `listLocations`, `findStockLevel`,
  `findStockLevelsByVariant`, `saveStockLevel`) + `StockTypeormRepository` are on
  disk.
- `StockCache` and `application/ports/stock-cache.port.ts` were **deleted** in
  task-01. `libs/cache/cache-keys.ts` still has `INVENTORY_STOCK_KEY_VERSION =
  'v1'` and the `inventoryStock*` builders keyed on **`productId`**, with
  `inventoryStockLegacyPrefix(productId)` (pre-v1) and `productStockPrefix`
  (pre-ADR-016) for invalidation fan-out.
- `ProductStockGetResponseDto` is gone; `INVENTORY_PRODUCT_STOCK_GET` is gone from
  `ROUTING_KEYS` + the legacy message-pattern enum. `INVENTORY_ORDER_CONFIRM`
  (deprecation stub) + `INVENTORY_STOCK_LOW` remain.
- `INVENTORY_DEFAULT_STOCK_LOCATION = 'default-warehouse'` and
  `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD` live in
  `libs/contracts/inventory/inventory.constants.ts`.
- The inventory `StockModule` registers the repository, the (kept) events
  publisher, the transaction adapter, and the confirm-stub `StockController`. The
  app still imports the global `CacheModule`.

## Scope

**In**
- New contract DTOs + RPC payload interfaces for variant availability + location
  listing.
- `libs/cache/cache-keys.ts`: bump `INVENTORY_STOCK_KEY_VERSION` `v1 → v2` and
  reshape the `inventoryStock*` builders to key on **`variantId`** + a
  stock-location facet; add a second legacy prefix builder for the now-retired
  `v1` keys. Update `libs/cache/spec/cache-keys.spec.ts`.
- Rebuild `IStockCachePort` + `StockCache` (+ spec) against the new payload, with
  `withInvalidation` items shaped `{ variantId, stockLocationId }`.
- `QueryAvailabilityUseCase` + `ListLocationsUseCase` (+ specs).
- Two new `@MessagePattern` handlers on `StockController`; new routing keys.
- Doc `04`.

**Out**
- Gateway endpoints, `http/inventory.http`, stock-level seed, the availability
  e2e (task-03).
- Receive / Adjust write paths + their `withInvalidation` callers (task-05) — but
  `withInvalidation` itself is built here so task-05 has it.
- The variant-created consumer (task-04).

## Contract DTOs (in `libs/contracts/inventory/`)

Create a `stock` sub-area (mirror the catalog `dto/` + `interfaces/` split).
Plain TS with `@nestjs/swagger` `@ApiResponseProperty` allowed (they are the
contract, ADR-005):

- `IVariantStockGetPayload` (RPC payload): `{ variantId: number;
  stockLocationIds?: string[]; correlationId?: string }`.
- `IStockLocationsListPayload` (RPC payload): `{ activeOnly?: boolean;
  correlationId?: string }`.
- `StockLevelView`: `{ stockLocationId: string; quantityOnHand: number;
  quantityAllocated: number; quantityReserved: number; available: number;
  version: number; updatedAt: Date | null }`.
- `VariantStockView` (the cached value): `{ variantId: number; totalOnHand: number;
  totalAvailable: number; locations: StockLevelView[] }`.
- `StockLocationView`: `{ id: string; name: string; code: string; type: string;
  gln: string | null; active: boolean }` (omit `address` from the view for now;
  add later if a consumer needs it).

Barrel them from `libs/contracts/inventory/index.ts`. These replace the deleted
`ProductStockGetResponseDto`.

## Cache-key bump (`libs/cache/cache-keys.ts`)

- Change `const INVENTORY_STOCK_KEY_VERSION = 'v1';` → `'v2'`.
- Reshape the current-convention builders to key on `variantId` and a
  stock-location facet (the all-locations sentinel stays the literal `__all__`;
  the sort comparator stays `localeCompare`):

  ```ts
  inventoryStockPrefix: (variantId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}inventory:stock:${INVENTORY_STOCK_KEY_VERSION}:${variantId}:`,

  inventoryStock: (variantId: number, stockLocationIds?: string[], opts?: ITenantOptions): string => {
    const prefix = CACHE_KEYS.inventoryStockPrefix(variantId, opts);
    const facet =
      stockLocationIds && stockLocationIds.length > 0
        ? sortedStorageFacet(stockLocationIds)
        : ALL_FACETS_SENTINEL;
    return `${prefix}${facet}`;
  },
  ```

- Add a **second** legacy prefix builder for the `v1` keys this bump retires,
  alongside the existing pre-v1 / pre-ADR-016 legacy builders (the epic calls for
  "`inventoryStockLegacyPrefix` gaining a second legacy prefix entry"). The
  cleanest shape is a distinct builder, e.g.:

  ```ts
  // Pre-v2 (v1) shape — invalidate-only. The v1 keys were `…inventory:stock:v1:<productId>:…`.
  // Note this keyed on the OLD productId axis; we wipe by the (now-variantId) numeric id,
  // which is sufficient for the rolling-deploy transition window (no production data exists).
  inventoryStockLegacyPrefixV1: (id: number): string => `ris:inventory:stock:v1:${id}:`,
  ```

  Keep `inventoryStockLegacyPrefix` (pre-v1, no version segment) and
  `productStockPrefix` (pre-ADR-016) as-is. Update the comment block at the top of
  the file to describe the four coexisting families.
- Update `libs/cache/spec/cache-keys.spec.ts` to assert the new `v2`/`variantId`
  literals and the new legacy builder.

> The `version` segment is a **constant next to the builder**, never a builder
> argument (ADR-022). Pre-bump `v1` entries become unreachable on the new code
> path and age out via TTL; the invalidate fan-out wipes them during the
> transition window.

## Cache port + adapter (rebuild)

Recreate `apps/.../stock/application/ports/stock-cache.port.ts` and
`apps/.../stock/infrastructure/cache/stock.cache.ts` (mirror the structure
task-01 deleted, but on the new types):

- `IStockCacheGetPayload` / `IStockCacheSetPayload`: `{ variantId: number;
  stockLocationIds?: string[]; tenantId?: string; correlationId?: string }`
  (+ `data: VariantStockView` on set).
- `IStockCacheInvalidateItem`: `{ variantId: number; stockLocationId: string }`.
- `IStockCacheGetResult`: `{ value: VariantStockView | undefined; available: boolean }`
  (keep the CACHE-005 `available` flag).
- `IStockCachePort`: `get` / `set` / `getOrLoad(payload, loader)` /
  `withInvalidation<T>(work, resolveItems, opts)` — **no public `invalidate`**
  (ADR-023). Keep the ±10% TTL jitter on `set` and the single-flight composition
  on `getOrLoad` (ADR-021).
- `invalidatePrefixes` fans out per `variantId` across the now-**four** prefixes:
  current `v2` (`inventoryStockPrefix`, tenanted), the new `inventoryStockLegacyPrefixV1`,
  `inventoryStockLegacyPrefix` (pre-v1), and `productStockPrefix` (pre-ADR-016).
- Re-add `STOCK_CACHE` to `application/ports/index.ts` and provide
  `StockCache` + `{ provide: STOCK_CACHE, useExisting: StockCache }` in
  `stock.module.ts`. Read `CACHE_TTL_MS_PRODUCT_STOCK` (the existing TTL env) as
  before, or introduce a clearly-named successor env if you prefer — if you rename
  it, update `libs/config` Joi + `README.md` env table + the carryover.
- Update `apps/.../stock/infrastructure/cache/spec/stock.cache.spec.ts` for the
  `v2` key + the `VariantStockView` payload + the `{ variantId, stockLocationId }`
  invalidate items.

## Use cases + controller

`QueryAvailabilityUseCase`
(`apps/.../stock/application/use-cases/query-availability.use-case.ts`):
- Input: `IVariantStockGetPayload`. Output: `VariantStockView`.
- Cache-aside via `stockCache.getOrLoad(payload, loader)`. The `loader` calls
  `repo.findStockLevelsByVariant(variantId, stockLocationIds)`, maps each to a
  `StockLevelView` (`available = onHand − allocated − reserved`), and aggregates
  `totalOnHand` / `totalAvailable`. An empty result is a valid cached value
  (`locations: []`, totals `0`).
- Skip-cache branches (caller-owned scope / `ignoreCache`) are **not** needed here
  (no transactional read path in this epic) — keep the use case simple.

`ListLocationsUseCase`
(`apps/.../stock/application/use-cases/list-locations.use-case.ts`):
- Input: `IStockLocationsListPayload`. Output: `StockLocationView[]` via
  `repo.listLocations(activeOnly)`.

`StockController` — add two `@MessagePattern` handlers (keep the confirm stub):
- `@MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_GET)` → `QueryAvailabilityUseCase`.
- `@MessagePattern(ROUTING_KEYS.INVENTORY_LOCATION_LIST)` → `ListLocationsUseCase`.

Register both use cases in `stock.module.ts`; repopulate
`application/use-cases/index.ts`.

## Routing keys

Add to `libs/messaging/routing-keys.constants.ts` (dotted
`<service>.<aggregate>.<action>`, ADR-008):
- `INVENTORY_STOCK_LEVEL_GET: 'inventory.stock-level.get'`
- `INVENTORY_LOCATION_LIST: 'inventory.location.list'`

Mirror both in `libs/contracts/microservices/microservice-message-pattern.enum.ts`
(value-for-value) and update `libs/messaging/spec/routing-keys.constants.spec.ts`.

## Files to add

- `libs/contracts/inventory/stock/variant-stock-get.payload.ts`
- `libs/contracts/inventory/stock/stock-locations-list.payload.ts`
- `libs/contracts/inventory/stock/stock-level.view.ts`
- `libs/contracts/inventory/stock/variant-stock.view.ts`
- `libs/contracts/inventory/stock/stock-location.view.ts`
- `libs/contracts/inventory/stock/index.ts`
- `apps/.../stock/application/ports/stock-cache.port.ts`
- `apps/.../stock/infrastructure/cache/stock.cache.ts`
- `apps/.../stock/infrastructure/cache/index.ts`
- `apps/.../stock/infrastructure/cache/spec/stock.cache.spec.ts`
- `apps/.../stock/application/use-cases/query-availability.use-case.ts` (+ `spec/`)
- `apps/.../stock/application/use-cases/list-locations.use-case.ts` (+ `spec/`)
- `apps/.../stock/application/use-cases/spec/test-doubles.ts` (fresh doubles for the new ports)
- `docs/implementation/04-inventory-stock-level-and-location/04-cache-key-bump-v1-to-v2.md`

## Files to modify

- `libs/cache/cache-keys.ts` (+ `libs/cache/spec/cache-keys.spec.ts`).
- `libs/contracts/inventory/index.ts` — barrel the new `stock/` exports.
- `libs/messaging/routing-keys.constants.ts` (+ spec);
  `libs/contracts/microservices/microservice-message-pattern.enum.ts`.
- `apps/.../stock/application/ports/index.ts` — re-export `stock-cache.port` +
  `STOCK_CACHE`.
- `apps/.../stock/application/use-cases/index.ts` — export the two new use cases.
- `apps/.../stock/presentation/stock.controller.ts` — add the two read handlers.
- `apps/.../stock/infrastructure/stock.module.ts` — provide `StockCache` +
  `STOCK_CACHE`, `QueryAvailabilityUseCase`, `ListLocationsUseCase`.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `query-availability.use-case.spec.ts` — cache hit returns cached `VariantStockView`
    without hitting the repo; miss loads from the repo + writes back via `getOrLoad`;
    a Redis-down read (`available: false`) falls back to the repo without a
    second warn; `available` math + aggregation; empty result is cached.
  - `list-locations.use-case.spec.ts` — returns mapped `StockLocationView[]`;
    `activeOnly` filter is honoured.
  - `stock.cache.spec.ts` — the `v2`/`variantId` key literal; jitter band on `set`;
    `withInvalidation` runs `work` first then fans out the four prefixes per
    `variantId`; rejection in `work` performs no cache mutation.
  - `cache-keys.spec.ts` — `inventoryStock(42)` → `ris:inventory:stock:v2:42:__all__`;
    the new `inventoryStockLegacyPrefixV1` literal; tenant-segment shape.
- **E2E** (`yarn test:e2e`) — unchanged from task-01 (no gateway wiring yet); the
  suite stays green.

## Doc deliverable

`04-cache-key-bump-v1-to-v2.md` — the ADR-022-style bump: why a DTO shape change
forces a version bump (the cached value goes from a SUM aggregate to a
`VariantStockView` projection); the new key shape
`ris:[t:<tenantId>:]inventory:stock:v2:<variantId>:<facet>`; the four coexisting
key families and which legacy prefixes the invalidate path still wipes (and why,
during the transition window); what `v1`-prefixed entries on Redis look like after
the bump and that they age out via TTL; that the cache *mechanism* (ADR-002 /
006 / 016 / 021 / 023) is unchanged — only the value shape + key version moved.
Cross-link `docs/adr/022-…md` and the sibling `07-availability-read-path.md`.

## Carryover to read

`carryover-01.md`.

## Carryover to produce

Write `carryover-02.md`. Capture: the new contract DTO names + RPC payload shapes;
that `INVENTORY_STOCK_KEY_VERSION` is now `'v2'` keyed on `variantId` + the new
legacy builder; the rebuilt `IStockCachePort` surface (`getOrLoad`,
`withInvalidation`, invalidate-item shape `{ variantId, stockLocationId }`); the
two new use cases + routing keys (`inventory.stock-level.get`,
`inventory.location.list`); the `StockModule` provider set; the cache TTL env used
(and whether it was renamed). Note the gaps owned by later tasks (gateway +
seed + availability e2e → task-03; consumer → task-04; Receive/Adjust + events +
the `withInvalidation` callers → task-05). List the verify commands
(`yarn lint`, `yarn test:unit`, `yarn test:e2e`, `yarn build`, the
self-containment grep).

## Exit criteria

- [ ] `INVENTORY_STOCK_KEY_VERSION` is `'v2'`; `inventoryStock(variantId)` →
      `ris:inventory:stock:v2:<variantId>:<facet>`; the new legacy prefix builder
      exists; `cache-keys.spec.ts` is green.
- [ ] `IStockCachePort` exposes `get` / `set` / `getOrLoad` / `withInvalidation`
      (no public `invalidate`); `StockCache` + spec are green on the new payload.
- [ ] `QueryAvailabilityUseCase` (cache-aside, per-location + aggregated) and
      `ListLocationsUseCase` exist with green specs; both are wired as
      `@MessagePattern` handlers and registered in `StockModule`.
- [ ] `inventory.stock-level.get` + `inventory.location.list` exist in
      `ROUTING_KEYS`, the legacy enum, and the routing-keys spec (value-for-value).
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `yarn test:e2e` passes (unchanged behaviour).
- [ ] `04-cache-key-bump-v1-to-v2.md` is written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-02.md` is written.
