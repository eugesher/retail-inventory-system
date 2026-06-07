---
epic: epic-04
task_number: 3
title: API-gateway read endpoints + stock-level seed + availability e2e
depends_on: [1, 2]
doc_deliverable: docs/implementation/04-inventory-stock-level-and-location/07-availability-read-path.md
adr_deliverable: none
---

# Task 03 — API-gateway read endpoints + stock-level seed + availability e2e

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-009** (`ClientProxy` only inside
`infrastructure/messaging/*-rabbitmq.adapter.ts`; controllers/use-cases/pipes
inject the port; gateway modules other than `auth` have no `domain/`), **ADR-010 /
ADR-024** (every route protected by default; opt out with `@Public()`;
`@RequiresPermission(<code>)` is the default gate; customer tokens carry no
`permissions`, so code-gated routes are staff-only), **ADR-008 / ADR-020**
(`ROUTING_KEYS` dotted constants), and **ADR-019** (idempotent SQL seeds under
`scripts/seeds/`).

## Goal

Expose the inventory read path over HTTP and prove it end-to-end. Rebuild the
gateway `modules/inventory/` (deleted in task-01) with two read endpoints —
`GET /api/inventory/locations` (staff, `inventory:read`) and
`GET /api/inventory/variants/:variantId/stock` (public) — backed by the
`inventory.location.list` + `inventory.stock-level.get` RPCs from task-02. Seed a
`StockLevel` row (100 on hand at `default-warehouse`) for each seeded variant so
the public read returns real figures, author the `http/inventory.http` read
requests, and add an availability e2e.

## Entry state assumed

- task-01 + task-02 carryovers present. The inventory service handles
  `inventory.stock-level.get` (→ `VariantStockView`) and `inventory.location.list`
  (→ `StockLocationView[]`); the confirm deprecation stub is still in place. The
  gateway has **no** inventory module and is **not** imported in the gateway
  `AppModule`.
- The contract DTOs `VariantStockView`, `StockLevelView`, `StockLocationView` and
  the payloads `IVariantStockGetPayload`, `IStockLocationsListPayload` exist in
  `libs/contracts/inventory/stock/`.
- `scripts/utils/test-db-seed.util.ts` `seedFiles` no longer lists
  `product-stock.sql`. `scripts/seeds/catalog-product-variant.sql` seeds variants
  with ids `1, 2, 3, 4`. The migration provisions `stock_location` row
  `default-warehouse`.
- `PermissionCodeEnum.INVENTORY_READ` (`inventory:read`) is seeded and bound to
  `warehouse-staff`; the `admin` role inherits it via `Object.values`.
- The gateway classifies `apps/api-gateway/src/modules/*/<layer>/**` automatically
  for boundaries lint — a rebuilt module needs no `eslint.config.mjs` change.

## Scope

**In**
- Rebuild gateway `modules/inventory/`: port + adapter + two use cases + two
  controllers (or one controller with both routes) + a query DTO + module;
  re-import `InventoryModule` in the gateway `AppModule`.
- `http/inventory.http` (new): the two read requests + `# Prereqs:` login block.
- `scripts/seeds/stock-level.sql` (new) + register it in `seedFiles`.
- `test/inventory-availability.e2e-spec.ts`.
- Doc `07`.

**Out**
- Receive / Adjust POST endpoints + their `http/inventory.http` requests (task-05).
- The variant-created consumer (task-04).
- README/CLAUDE full pass (task-06) — only touch them here if a read-route detail
  must be corrected; otherwise leave for task-06.

## Gateway module (rebuild)

Mirror the catalog gateway module's hexagonal shape (ADR-009). Name the module
after the downstream service (`inventory`), not the URL prefix.

- **Port** `application/ports/inventory-gateway.port.ts`
  (`INVENTORY_GATEWAY_PORT`):
  ```ts
  getVariantStock(query: { variantId: number; stockLocationIds?: string[] }, correlationId: string): Promise<VariantStockView>;
  listLocations(query: { activeOnly?: boolean }, correlationId: string): Promise<StockLocationView[]>;
  ```
- **Adapter** `infrastructure/messaging/inventory-rabbitmq.adapter.ts` — the sole
  `ClientProxy` holder; `client.send(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_GET, …)`
  and `…INVENTORY_LOCATION_LIST`, threading `correlationId`. Imports
  `MicroserviceClientInventoryModule`.
- **Use cases** `GetVariantStockUseCase`, `ListLocationsUseCase` (gateway-side
  thin orchestrators that call the port).
- **Presentation** — two routes:
  - `GET /api/inventory/locations` — `@RequiresPermission(PermissionCodeEnum.INVENTORY_READ)`,
    `@ApiBearerAuth()`. Returns `StockLocationView[]`.
  - `GET /api/inventory/variants/:variantId/stock` — `@Public()`. Path param
    `variantId` via `ParseIntPipe`; query `?locationIds=…`. Returns
    `VariantStockView` (per-location + totals).
  - A `VariantStockQueryDto` parses `?locationIds` the same way the old
    `ProductStockGetQueryDto` parsed `storageIds` (a JSON-encoded array string via
    `@Transform`), or accept a simpler comma-separated form — pick one, document
    it in the `.http` header, and validate it. Omitting `locationIds` returns all
    locations.
- **Module** `inventory.module.ts` — imports `MicroserviceClientInventoryModule`;
  controllers + use cases + `{ provide: INVENTORY_GATEWAY_PORT, useClass:
  InventoryRabbitmqAdapter }`. Re-add `InventoryModule` to the gateway
  `AppModule` imports.

> The `default-warehouse` id is the implicit target when a write body omits
> `stockLocationId` (task-05). For reads, omitting `?locationIds` aggregates across
> all locations. Document both behaviours in the `.http` header.

## Seed (`scripts/seeds/stock-level.sql`)

Idempotent (`INSERT IGNORE`), one `StockLevel` row per seeded variant at the
default location, 100 on hand:

```sql
INSERT IGNORE INTO stock_level
  (variant_id, stock_location_id, quantity_on_hand, quantity_allocated, quantity_reserved, version)
VALUES
  (1, 'default-warehouse', 100, 0, 0, 0),
  (2, 'default-warehouse', 100, 0, 0, 0),
  (3, 'default-warehouse', 100, 0, 0, 0),
  (4, 'default-warehouse', 100, 0, 0, 0);
```

Register `'stock-level.sql'` in `TestDbSeedUtil.seedFiles` **after**
`catalog-product-variant.sql` (the `variant_id` FK requires the variants to exist
first; `stock_location` exists from the migration, not a seed). Re-running
`yarn test:seed` must not error or duplicate rows.

> This explicit seed exists because `yarn test:seed` may run before any RMQ
> consumer is up, so it cannot rely on the auto-init path (task-04). It simulates
> what auto-init + a receive would produce.

## `http/inventory.http`

New Kulala file (ADR §9 of the execution requirements). Header cites the
controller paths, documents the seeded `default-warehouse` location id, and
explains the `?locationIds` encoding and the omit-to-aggregate behaviour. Include
a `# Prereqs:` block capturing a staff bearer token into `@accessToken` (the
locations route is protected). Requests:
- `# @name listLocations` — `GET {{baseUrl}}/inventory/locations` with
  `Authorization: Bearer {{accessToken}}`.
- `# @name getVariantStockAllLocations` — `GET {{baseUrl}}/inventory/variants/1/stock`
  (public; no auth header needed).
- `# @name getVariantStockFiltered` —
  `GET {{baseUrl}}/inventory/variants/1/stock?locationIds=…` (documented encoding).

No `tmp/`, "epic", or "task" strings anywhere in the file.

## Files to add

- `apps/api-gateway/src/modules/inventory/application/ports/inventory-gateway.port.ts`
- `apps/api-gateway/src/modules/inventory/application/ports/index.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/get-variant-stock.use-case.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/list-locations.use-case.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/index.ts`
- `apps/api-gateway/src/modules/inventory/infrastructure/messaging/inventory-rabbitmq.adapter.ts`
- `apps/api-gateway/src/modules/inventory/infrastructure/messaging/index.ts`
- `apps/api-gateway/src/modules/inventory/presentation/inventory.controller.ts` (both read routes)
- `apps/api-gateway/src/modules/inventory/presentation/dto/variant-stock-query.dto.ts`
- `apps/api-gateway/src/modules/inventory/presentation/dto/index.ts`
- `apps/api-gateway/src/modules/inventory/presentation/index.ts`
- `apps/api-gateway/src/modules/inventory/inventory.module.ts`
- `apps/api-gateway/src/modules/inventory/index.ts`
- `http/inventory.http`
- `scripts/seeds/stock-level.sql`
- `test/inventory-availability.e2e-spec.ts`
- `docs/implementation/04-inventory-stock-level-and-location/07-availability-read-path.md`

## Files to modify

- `apps/api-gateway/src/app/app.module.ts` — import + register the rebuilt
  `InventoryModule`.
- `scripts/utils/test-db-seed.util.ts` — add `'stock-level.sql'` to `seedFiles`.

## Files to delete

None (`http/product.http` and the old gateway module were deleted in task-01).

## Tests

- **E2E** `test/inventory-availability.e2e-spec.ts` (run via `yarn test:e2e`,
  which reloads infra + migrates + seeds):
  - Public `GET /api/inventory/variants/1/stock` returns `totalOnHand = 100`,
    `totalAvailable = 100`, one `default-warehouse` location entry — **without** an
    Authorization header (proves `@Public()`).
  - The same call twice proves cache miss then hit (assert the second response
    equals the first; optionally assert a cache key `ris:inventory:stock:v2:1:…`
    exists via the test Redis client, mirroring the patterns in other e2e specs).
  - `GET /api/inventory/locations` **without** a token → `401`; **with** a staff
    token (seeded `warehouse-staff` or `admin`) → `200` and includes
    `default-warehouse`.
  - `GET /api/inventory/variants/999/stock` (no stock level) → `200` with
    `totalOnHand = 0`, `locations: []` (empty is a valid availability answer).
- **Unit** — the gateway use cases are thin; a spec is optional. `yarn test:unit`
  stays green.

## Doc deliverable

`07-availability-read-path.md` — the cache-aside read path on the new model
(read-through on miss, write-back, post-commit invalidation handled by the write
paths); the `VariantStockView` shape (per-location `StockLevelView` + aggregated
totals); per-location vs aggregated reads (`?locationIds` vs omit); the public
customer read vs the staff-gated `locations` list (ADR-024); how the seed
guarantees a figure before any consumer runs. Cross-link
`04-cache-key-bump-v1-to-v2.md` and `docs/adr/002-…md` / `docs/adr/009-…md`.

## Carryover to read

`carryover-01.md`, `carryover-02.md`.

## Carryover to produce

Write `carryover-03.md`. Capture: the gateway route list + their auth gates; the
`INVENTORY_GATEWAY_PORT` method shapes + the adapter's routing-key usage; the
`?locationIds` encoding chosen; the `stock-level.sql` seed (variant ids `1–4`,
100 on hand at `default-warehouse`) + its `seedFiles` position; the
`http/inventory.http` request names. Note the gaps owned by later tasks
(auto-init consumer → task-04; Receive/Adjust POST endpoints + their `.http`
requests + write/cache e2e → task-05; README/CLAUDE full pass + doc `08` →
task-06). List the verify commands, including the exact `http/inventory.http`
read calls and a `redis-cli --scan 'ris:inventory:stock:v2:*'` check.

## Exit criteria

- [ ] `GET /api/inventory/locations` (staff, `inventory:read`) and
      `GET /api/inventory/variants/:variantId/stock` (public) work end-to-end
      through the rebuilt gateway module.
- [ ] After `yarn test:seed`, the public variant-stock GET returns 100 on hand at
      `default-warehouse` for each seeded variant; the seed is idempotent.
- [ ] `http/inventory.http` exists; its read requests execute (locations with a
      bearer token, variant stock without one).
- [ ] `test/inventory-availability.e2e-spec.ts` is green (public read, 401/200 on
      locations, empty-stock answer, cache miss-then-hit).
- [ ] Redis keys observed match `ris:inventory:stock:v2:<variantId>:<facet>`.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `yarn test:e2e` passes.
- [ ] `07-availability-read-path.md` is written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-03.md` is written.
