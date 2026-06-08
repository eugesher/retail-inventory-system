# Carryover 01 — Drop the legacy inventory model; new StockLocation + StockLevel foundation

> Read this before starting task-02. It records the on-disk state task-01 left
> behind. (This file lives under `tmp/`; the self-containment rule does not
> apply here.)

## Entry state for task-02

- **Schema is live.** `product_stock`, `product_stock_action`, and `storage` are
  dropped. `stock_location` + `stock_level` exist (verified against the running
  MySQL 8.4):
  - `stock_location`: `id VARCHAR(64) PK` (caller-assigned), `name`, `code`
    (UNIQUE `UC_STOCK_LOCATION_CODE`), `type ENUM('warehouse','store','dropship-virtual')`,
    `address JSON NULL`, `gln VARCHAR(13) NULL`, `active BOOLEAN`,
    `created_at`/`updated_at`/`deleted_at` (deleted_at inert).
  - `stock_level`: `id BIGINT UNSIGNED AUTO_INCREMENT PK`, `variant_id BIGINT UNSIGNED`,
    `stock_location_id VARCHAR(64)`, `quantity_on_hand`/`quantity_allocated`/`quantity_reserved INT`,
    **`version INT`**, timestamps. `UNIQUE (variant_id, stock_location_id)`,
    FK→`stock_location(id)` and FK→`product_variant(id)` (both `ON DELETE RESTRICT`),
    three `CHECK (… >= 0)`, index `IDX_STOCK_LEVEL_LOCATION`.
  - `default-warehouse` row is provisioned (idempotent `ON DUPLICATE KEY UPDATE`).
- **Domain models** (framework-free, throw plain `Error`):
  - `StockLocation` + **`StockLocationTypeEnum`** (`WAREHOUSE`/`STORE`/`DROPSHIP_VIRTUAL`)
    at `apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts`.
    Invariants: id/name/code non-empty, `gln` matches `^\d{13}$`; `deactivate()` flips `active`.
    > Note: the enum is `StockLocationTypeEnum` (the task brief's "StockLevelTypeEnum"
    > was a typo — there is no type enum on `StockLevel`).
  - `StockLevel` at `.../domain/stock-level.model.ts`: non-negative-integer
    quantities + version; `get available()`; `changeOnHand(delta)` (rejects negative
    result, bumps `version`); `static initialAt(variantId, stockLocationId)` → zeros + version 0.
    No `allocate`/`reserve`/`release` (later inventory-reservation capability).
- **Repository port** `IStockRepositoryPort` (symbol `STOCK_REPOSITORY` unchanged),
  domain types only:
  ```ts
  findLocation(id: string): Promise<StockLocation | null>;
  listLocations(activeOnly?: boolean): Promise<StockLocation[]>;
  findStockLevel(variantId: number, stockLocationId: string): Promise<StockLevel | null>;
  findStockLevelsByVariant(variantId: number, stockLocationIds?: string[]): Promise<StockLevel[]>;
  saveStockLevel(stockLevel: StockLevel): Promise<StockLevel>; // upsert; re-reads for concrete id
  ```
  Implemented in `StockTypeormRepository` (only `@InjectRepository` site; injects
  both `StockLevelEntity` + `StockLocationEntity` repos).
- **Inventory service exposes ONLY the `inventory.order.confirm` deprecation stub**
  (`StockController.handleOrderConfirm` throws a typed `RpcException`:
  `'inventory.order.confirm is deprecated; reservation is handled by the inventory-reservation capability'`).
  The `inventory.product-stock.get` handler + routing key are removed.
- **Gateway has NO inventory module** (`apps/api-gateway/src/modules/inventory/`
  deleted; unregistered from `app.module.ts`).
- **`StockCache` + `stock-cache.port.ts` are DELETED** (task-02 rebuilds them).
  `libs/cache/cache-keys.ts` is **still `v1`** (`INVENTORY_STOCK_KEY_VERSION` untouched;
  the `inventoryStock*` builders remain, now unused by apps).
- **Kept & reused by later tasks:** `domain/events/*` (StockLow/Reserved/Released),
  `infrastructure/messaging/stock-rabbitmq.publisher.ts` + `STOCK_EVENTS_PUBLISHER`,
  `infrastructure/persistence/typeorm-transaction.adapter.ts` + `TRANSACTION_PORT`.
  The inventory `app.module.ts` still imports `CacheModule` (global, currently unused).

## Key decisions & deviations

- **ADR number allocated: 027** (`docs/adr/027-stocklevel-running-totals-and-stocklocation.md`).
  ADR-012 flipped to `Superseded by ADR-027` (status line + index row updated).
- **`INVENTORY_DEFAULT_STOCK_LOCATION = 'default-warehouse'`** replaces
  `INVENTORY_DEFAULT_STORAGE` in `libs/contracts/inventory/inventory.constants.ts`.
  `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD` kept.
- **`stock_location.id` string-PK divergence from `BaseEntity`:** `StockLocationEntity`
  cannot `extends BaseEntity` with `id: string` (TS2416 — `string` not assignable to
  the inherited `number`). Resolved idiomatically by re-typing the base ctor:
  `const StockLocationBaseEntity: abstract new () => Omit<BaseEntity,'id'> = BaseEntity;`
  then `extends StockLocationBaseEntity` with `@PrimaryColumn({type:'varchar',length:64}) id`.
  Inherits the timestamp/`deletedAt` columns; verified compiling + the migration `up`
  + a repo read of `default-warehouse`. `StockLevelEntity` extends `BaseEntity` normally
  (BIGINT PK) and maps `variant_id` as a plain BIGINT scalar (no `@ManyToOne`);
  `version` is `@VersionColumn()` (TypeORM owns the persisted value).
- **Removed routing key `inventory.product-stock.get`** from `ROUTING_KEYS`, the
  `MicroserviceMessagePatternEnum`, and the value-for-value agreement spec.
- **Kept the confirm stub + `IProductStockOrderConfirmPayload`** so the retail
  `InventoryConfirmRabbitmqAdapter` still type-checks (ADR-013 §7). `ProductStockGetResponseDto`,
  `IProductStockGetPayload`, and the whole `product-stock-get/` contract dir are deleted.
  `ProductStockActionEnum` (in `product-stock.types.ts`) was **left in place** (now unused;
  out of task scope to remove — a candidate for a later cleanup).
- **`system-api.e2e` was TRIMMED** (not deleted): the `Product` block and the
  `PUT /api/order/:id/confirm` block were removed; only `POST /api/order`
  create/validation tests remain. Cache helpers + `ProductStockGetResponseDto`/`CACHE_KEYS`
  imports removed. `getProductStockRowsByOrderId` removed from the e2e data-source.
  27 obsolete snapshots pruned (`jest -u` on a fresh seed); 11 POST snapshots retained.
- **`auth.e2e` was repointed to `/api/auth/me`** (both the 401-without-token and
  200-with-token assertions preserved).
- **`spec/architecture-lint.spec.ts`** fixtures that imported the deleted real files
  (`stock.cache.ts`, `product-stock.entity.ts`) were repointed to `stock-level.entity.ts`
  (the boundaries resolver needs a real target file); the positive infra→lib-cache
  fixture path was moved off the deleted `infrastructure/cache/` to `infrastructure/persistence/`.
- **CLAUDE.md / README.md** got only the minimal route/RPC edits the task scoped
  (the dead `GET /api/product/:productId/stock` route + the `inventory.product-stock.get`
  RPC removed; gateway inventory module subtree removed; DB-box table list updated;
  status notes added pointing at ADR-027). **The full inventory rewrite of these
  files is task-06** — the inventory-microservice stock tree + Caching section prose
  still describe the superseded `StockItem`/`product_stock` model and are flagged as such.

## Files added / modified / deleted

**Added:** `stock-location.model.ts`, `stock-level.model.ts` (+ specs);
`stock-location.entity.ts`, `stock-level.entity.ts`, `stock-location.mapper.ts`,
`stock-level.mapper.ts`; rewritten `spec/stock-typeorm.repository.spec.ts`;
`migrations/1780860153719-ReplaceProductStockWithStockLevelAndLocation.ts`;
`docs/adr/027-…md`; `docs/implementation/04-inventory-stock-level-and-location/{01,02,03}-….md`.

**Modified:** stock `domain/index.ts`, `application/ports/index.ts`,
`application/ports/stock.repository.port.ts`, `infrastructure/persistence/index.ts`,
`infrastructure/persistence/stock-typeorm.repository.ts`, `infrastructure/stock.module.ts`,
`presentation/stock.controller.ts`; gateway `app/app.module.ts`;
`libs/contracts/inventory/inventory.constants.ts`, `.../product-stock/index.ts`;
`libs/contracts/microservices/microservice-message-pattern.enum.ts`;
`libs/messaging/routing-keys.constants.ts` (+ spec); `scripts/utils/test-db-seed.util.ts`;
`spec/architecture-lint.spec.ts`; `test/system-api.e2e-spec.ts`,
`test/data-source/system-api.e2e-spec.data-source.ts`, `test/auth.e2e-spec.ts`,
`test/__snapshots__/system-api.e2e-spec.ts.snap`; `docs/adr/012-…md`, `docs/adr/index.md`;
`README.md`, `CLAUDE.md`.

**Deleted:** stock `domain/{stock-item,storage}.model.ts` (+ specs);
`infrastructure/persistence/{product-stock,product-stock-action,storage}.entity.ts`,
`stock-item.mapper.ts`; `application/use-cases/*` (add/get/reserve + specs + test-doubles + barrel);
`infrastructure/cache/*` (stock.cache + spec + index); `application/ports/stock-cache.port.ts`;
the whole gateway `apps/api-gateway/src/modules/inventory/` tree;
`libs/contracts/inventory/product-stock/product-stock-get/*`; `http/product.http`;
`scripts/seeds/product-stock.sql`.

## Known gaps / deferrals

- **Read availability RPC + `StockCache` rebuild + cache key `v1→v2` bump → task-02.**
  (`cache-keys.ts` is still `v1`; `IStockCachePort`/`STOCK_CACHE` were deleted.)
- **Gateway inventory endpoints + new `http/*.http` + stock-level seed → task-03.**
- **`variant.created` auto-init consumer → task-04.**
- **Receive/Adjust operations + events (incl. `inventory.stock.low` wiring) → task-05.**
- **Full inventory rewrite of README.md / CLAUDE.md → task-06.**
- **Reservation/allocation/StockMovement + no-oversell enforcement of `version` →
  a later inventory-reservation capability.**
- Minor: `ProductStockActionEnum` is now dead exported code (left in scope-wise).

## How to verify (all run green this session)

```bash
yarn lint                 # exit 0 (--max-warnings 0)
yarn test:unit            # 64 suites, 445 tests pass
yarn build                # all 5 apps compile
# migration cycle (infra up):
yarn migration:run        # applies cleanly; SHOW TABLES → stock_location, stock_level; default-warehouse present
yarn migration:revert     # restores product_stock/product_stock_action/storage (no product FK) + re-seeds rows
yarn migration:run        # re-applies; default-warehouse insert idempotent
yarn test:e2e             # reload + seed (no product-stock.sql) + 7 suites / 82 tests pass
grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md   # CLEAN
# boot check: the e2e boots the inventory microservice with only the confirm stub (DI resolves cleanly).
```
