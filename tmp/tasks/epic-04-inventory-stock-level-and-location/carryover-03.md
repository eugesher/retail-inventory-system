# Carryover 03 — API-gateway read endpoints + stock-level seed + availability e2e

> Read this before starting task-04 (after `carryover-01.md` + `carryover-02.md`).
> It records the on-disk state task-03 left behind. (This file lives under `tmp/`;
> the self-containment rule does not apply here.)

## Entry state for task-04

- **The gateway `inventory` module is rebuilt and registered.** It fronts the two
  inventory read RPCs over HTTP at `/api/inventory`, mirroring the catalog gateway
  module's hexagonal shape (ADR-009). Subtree:
  `apps/api-gateway/src/modules/inventory/`
  - `application/ports/inventory-gateway.port.ts` — `INVENTORY_GATEWAY_PORT`
    (symbol) + `IInventoryGatewayPort`. Method shapes:
    ```ts
    getVariantStock(query: { variantId: number; stockLocationIds?: string[] }, correlationId: string): Promise<VariantStockView>;
    listLocations(query: { activeOnly?: boolean }, correlationId: string): Promise<StockLocationView[]>;
    ```
    Query inputs (`IGetVariantStockQuery` / `IListLocationsQuery`) omit
    `correlationId` — it is threaded separately and stitched onto the wire payload
    in the adapter (the catalog-gateway split).
  - `infrastructure/messaging/inventory-rabbitmq.adapter.ts` — the **sole
    `ClientProxy` holder**. Injects `MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE`,
    imports `MicroserviceClientInventoryModule` (via the module). Sends
    `ROUTING_KEYS.INVENTORY_STOCK_LEVEL_GET` (payload `IVariantStockGetPayload`)
    and `ROUTING_KEYS.INVENTORY_LOCATION_LIST` (payload `IStockLocationsListPayload`),
    each with `{ ...query, correlationId }`, materialized with `firstValueFrom`.
  - `application/use-cases/{get-variant-stock,list-locations}.use-case.ts` — thin
    orchestrators (logger.assign(correlationId) → port call → `throwRpcError` on
    catch), the catalog read use-case pattern.
  - `presentation/inventory.controller.ts` — `@ApiTags('Inventory')`,
    `@Controller('inventory')`. **Two routes:**
    - `GET /api/inventory/locations` — `@RequiresPermission(PermissionCodeEnum.INVENTORY_READ)`
      + `@ApiBearerAuth()`. Optional `?activeOnly` via
      `ParseBoolPipe({ optional: true })`. Returns `StockLocationView[]`.
    - `GET /api/inventory/variants/:variantId/stock` — `@Public()`. `variantId`
      via `ParseIntPipe`; `?locationIds` via `VariantStockQueryDto`. Returns
      `VariantStockView`. Controller maps `query.locationIds` → the port's
      `stockLocationIds`.
  - `presentation/dto/variant-stock-query.dto.ts` — `VariantStockQueryDto`.
  - `inventory.module.ts` — imports `MicroserviceClientInventoryModule`;
    controller `InventoryController`; providers the two use cases +
    `{ provide: INVENTORY_GATEWAY_PORT, useClass: InventoryRabbitmqAdapter }`.
  - Barrels: `application/ports/index.ts`, `application/use-cases/index.ts`,
    `infrastructure/messaging/index.ts`, `presentation/dto/index.ts`,
    `presentation/index.ts`, `index.ts`.
  - **`InventoryModule` is registered** in `apps/api-gateway/src/app/app.module.ts`
    (import + in the `imports: [...]` array, after `CatalogModule`).

- **`?locationIds` encoding chosen: comma-separated** —
  `?locationIds=default-warehouse,backup-store` (NOT a JSON-encoded array string).
  The `@Transform` in `VariantStockQueryDto` splits every token on commas, trims,
  drops empties, and tolerates the repeated-param form
  (`?locationIds=a&locationIds=b`). Omitted/empty → `undefined` → the RPC reads it
  as "all locations". Validated with `@IsArray` + `@IsString({ each: true })`.

- **The stock-level seed exists and is registered.**
  `scripts/seeds/stock-level.sql` — idempotent (`INSERT IGNORE`), one
  `stock_level` row per seeded variant (ids `1,2,3,4`), `100` on hand /
  `0` allocated / `0` reserved / `version 0`, all at `'default-warehouse'`.
  Registered in `scripts/utils/test-db-seed.util.ts` `seedFiles` as the **last
  entry, after `price.sql`** (it only needs to follow `catalog-product-variant.sql`
  for the `variant_id` FK; `stock_location` comes from the migration). Re-running
  `yarn test:seed` does not error or duplicate.

- **`http/inventory.http` exists** (Kulala). `@baseUrl = {{ENV_BASE_URL}}`; a
  `# Prereqs:` block + `# @name login` (`POST /api/auth/staff/login`, admin)
  capturing `@accessToken`. Request names:
  - `login`
  - `listLocations` — `GET {{baseUrl}}/inventory/locations` with
    `Authorization: Bearer {{accessToken}}`.
  - `getVariantStockAllLocations` — `GET {{baseUrl}}/inventory/variants/1/stock`
    (no auth header — proves `@Public()`).
  - `getVariantStockFiltered` —
    `GET {{baseUrl}}/inventory/variants/1/stock?locationIds=default-warehouse`.
  Header documents the seeded `default-warehouse` id, the comma-separated
  `?locationIds` encoding, and the omit-to-aggregate behaviour. No
  `tmp/`/epic/task strings.

- **E2E** `test/inventory-availability.e2e-spec.ts` (boots the inventory
  microservice on `INVENTORY_QUEUE` + the gateway, the `system-api.e2e` pattern).
  6 tests, all green: public read returns `totalOnHand/totalAvailable = 100` with
  one `default-warehouse` entry (no auth header); miss-then-hit (second body deep-
  equals first); zero-availability `200` (`locations: []`) for variant `999`;
  single-location scope via `?locationIds`; `401` on locations without a token;
  `200` + includes `default-warehouse` with an admin token.

## Key decisions & deviations

- **No ADR for this task** (the doc_deliverable said `adr_deliverable: none`).
  Implementation doc written:
  `docs/implementation/04-inventory-stock-level-and-location/07-availability-read-path.md`
  (cross-links `04-cache-key-bump-v1-to-v2.md`, ADR-002, ADR-009, ADR-023,
  ADR-024). Doc `04` already forward-linked `07`; that link is now live.
- **Locations route is NOT cached** (only the per-variant stock read is — the
  cache-aside seam already lived in the inventory `QueryAvailabilityUseCase` from
  task-02). The gateway adds no caching of its own.
- **Redis key format confirmed empirically** by running the spec against live
  infra and scanning Redis: the live app writes **`ris:inventory:stock:v2:<variantId>:<facet>`
  with NO keyv namespace prefix** (e.g. `ris:inventory:stock:v2:1:__all__`,
  `ris:inventory:stock:v2:1:default-warehouse`, `ris:inventory:stock:v2:999:__all__`).
  So `redis-cli --scan 'ris:inventory:stock:v2:*'` is the correct probe. (A
  standalone `cache-manager` `createCache` probe did NOT reproduce this — only the
  real `NestCacheModule` path writes the clean keys; don't reverse-engineer the
  key from a hand-built Keyv.)
- **Surgical README.md / CLAUDE.md edits only** (the precedent from task-01/02 —
  the full inventory rewrite is task-06):
  - CLAUDE.md: the inventory message-pattern bullet now says the gateway fronts
    both read RPCs; the gateway section now lists **three** RPC-fronting modules
    (added the `modules/inventory/` bullet with both routes + the `?locationIds`
    note).
  - README.md: the ASCII route box gained an Inventory block; the gateway layout
    tree gained the `inventory/` subtree (catalog reflowed `└──`→`├──`); a new
    `### Inventory` API subsection (both routes + the cache-aside/seed paragraph);
    the `@Public()` list now names the variant-stock read.
- **`InventoryController` route order:** `locations` is declared before
  `variants/:variantId/stock` so the literal path is matched ahead of the param
  route (defensive; they don't actually collide).

## Known gaps / deferrals

- **`variant.created` auto-init consumer → task-04.** The seed
  (`stock-level.sql`) is the stand-in that guarantees a figure before any consumer
  runs; task-04 adds the inventory-side consumer that auto-initializes a
  `stock_level` row on a catalog `variant.created` event. (Doc `07` already frames
  the seed as simulating "what auto-init + a receive would produce".)
- **Receive / Adjust POST endpoints + their `http/inventory.http` requests +
  write/cache-invalidation e2e → task-05.** Today `http/inventory.http` holds only
  the two read requests; the gateway inventory module has no write routes. The
  inventory-side `withInvalidation` helper (built in task-02) is still unused.
- **Full inventory rewrite of `README.md` (the "Caching" section still describing
  the old `v1`/`productId`/`SUM` model) + the `CLAUDE.md` inventory-microservice
  `StockItem`/`product_stock` bullet + doc `08` → task-06.** The inventory-
  microservice box in the README diagram still shows only `inventory.order.confirm`
  + `inventory.stock.low` (not the two read RPCs) — left for the task-06 pass.
- **`ProductStockActionEnum`** (in
  `libs/contracts/inventory/product-stock/product-stock.types.ts`) is still dead
  exported code (inherited from task-01).
- **Reservation/allocation + no-oversell enforcement of `version` → a later
  inventory-reservation capability.**

## How to verify (all run green this session)

```bash
yarn lint                 # exit 0 (--max-warnings 0)
yarn test:unit            # 67 suites, 478 tests pass (unchanged — gateway use cases are thin, no new unit spec)
yarn build                # all 5 apps compile
yarn test:e2e             # reload + seed (now incl. stock-level.sql) + 8 suites / 88 tests pass
                          #   (+1 suite / +6 tests vs task-02's 82: inventory-availability.e2e-spec.ts)
grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md   # CLEAN (exit 1)

# Live read-path check (docker compose up -d; yarn migration:run; yarn test:seed; yarn start:dev):
curl -s http://localhost:3000/api/inventory/variants/1/stock | jq         # totalOnHand 100, one default-warehouse entry, no token
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/inventory/locations   # 401 without a token
redis-cli --scan 'ris:inventory:stock:v2:*'                               # ris:inventory:stock:v2:1:__all__ (after a read)

# http/inventory.http read calls (run `login` first, then):
#   listLocations               -> GET /api/inventory/locations            (Bearer)
#   getVariantStockAllLocations -> GET /api/inventory/variants/1/stock      (public)
#   getVariantStockFiltered     -> GET /api/inventory/variants/1/stock?locationIds=default-warehouse
```

## Files added / modified

**Added:**
`apps/api-gateway/src/modules/inventory/` — `application/ports/{inventory-gateway.port,index}.ts`,
`application/use-cases/{get-variant-stock.use-case,list-locations.use-case,index}.ts`,
`infrastructure/messaging/{inventory-rabbitmq.adapter,index}.ts`,
`presentation/{inventory.controller,index}.ts`,
`presentation/dto/{variant-stock-query.dto,index}.ts`,
`inventory.module.ts`, `index.ts`;
`http/inventory.http`; `scripts/seeds/stock-level.sql`;
`test/inventory-availability.e2e-spec.ts`;
`docs/implementation/04-inventory-stock-level-and-location/07-availability-read-path.md`.

**Modified:**
`apps/api-gateway/src/app/app.module.ts` (import + register `InventoryModule`);
`scripts/utils/test-db-seed.util.ts` (append `'stock-level.sql'` to `seedFiles`);
`README.md`, `CLAUDE.md` (surgical route/module edits).

**Deleted:** none.
