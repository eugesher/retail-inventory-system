# Carryover 04 — Auto-init StockLevel = 0 on catalog.variant.created

> Read this before starting task-05 (after `carryover-01..03.md`). It records the
> on-disk state task-04 left behind. (This file lives under `tmp/`; the
> self-containment rule does not apply here.)

## Entry state for task-05

- **The inventory microservice now consumes `catalog.variant.created`** (the first
  cross-service consumer beyond notification). Path:
  `apps/inventory-microservice/src/modules/stock/infrastructure/consumers/catalog-events.consumer.ts`
  — a `@Controller()` with `@EventPattern(ROUTING_KEYS.CATALOG_VARIANT_CREATED)`
  `onVariantCreated(@Payload() event: ICatalogVariantCreatedEvent)` that logs
  `correlationId` **inline** (ADR-011 §7) and calls
  `AutoInitStockLevelUseCase.execute(event)`. Barrel:
  `infrastructure/consumers/index.ts`. Registered in `StockModule.controllers`
  (alongside `StockController`).

- **`AutoInitStockLevelUseCase`**
  (`application/use-cases/auto-init-stock-level.use-case.ts`, barrelled from
  `use-cases/index.ts`). Contract: `execute(event: ICatalogVariantCreatedEvent): Promise<void>`.
  Injects `STOCK_REPOSITORY` + `STOCK_EVENTS_PUBLISHER` + `PinoLogger`.
  Idempotency rule (two layers):
  1. `findStockLevel(variantId, INVENTORY_DEFAULT_STOCK_LOCATION)` → if present,
     **no-op** (no save, no event).
  2. Else `saveStockLevel(StockLevel.initialAt(variantId, 'default-warehouse'))`;
     on a duplicate-key driver error (`ER_DUP_ENTRY` / errno `1062`, **duck-typed**
     on `error.driverError` since the app layer must not import `typeorm`) the
     INSERT race is swallowed as the already-exists no-op.
  Emits `inventory.stock-level.initialized` **only on a genuinely new row**.
  Default location id is the constant `INVENTORY_DEFAULT_STOCK_LOCATION`
  (`'default-warehouse'`), never a literal at the call site.

- **The catalog publisher now emits `catalog.variant.created` onto
  `inventory_queue`.** `CatalogRabbitmqPublisher`
  (`apps/catalog-microservice/.../catalog/infrastructure/messaging/`) injects
  **two** clients: `CATALOG_MICROSERVICE` (for `publishProductPublished` /
  `publishProductArchived` → `catalog_queue`, reserved) and `INVENTORY_MICROSERVICE`
  (for `publishVariantCreated` → `inventory_queue`). `catalog.module.ts` now imports
  **`MicroserviceClientInventoryModule`** (in addition to
  `MicroserviceClientCatalogModule`). The `ICatalogEventsPublisherPort` signatures
  are unchanged; only the destination client for variant-created changed.

- **The inventory `StockModule` now imports `MicroserviceClientInventoryModule`**
  (in addition to `MicroserviceClientNotificationModule`). `StockRabbitmqPublisher`
  injects **both** clients: notification (for `publishStockLow` →
  `notification_events`) and inventory (for the new
  `publishStockLevelInitialized` → `inventory_queue`). `AutoInitStockLevelUseCase`
  is registered in `StockModule.providers`.

- **New domain event** `StockLevelInitializedEvent`
  (`domain/events/stock-level-initialized.event.ts`, barrelled) — a
  `DomainEvent<number>` (aggregateId = `variantId`) carrying `stockLocationId`;
  mirrors `StockLowEvent`. **New wire event**
  `IInventoryStockLevelInitializedEvent`
  (`libs/contracts/inventory/events/stock-level-initialized.event.ts`, barrelled):
  `extends ICorrelationPayload` with `{ variantId: number; stockLocationId: string;
  eventVersion: 'v1'; occurredAt: string }`. The publisher maps domain → wire (a
  `DomainEvent` is never serialized cross-service, ADR-011).

- **New routing key** `INVENTORY_STOCK_LEVEL_INITIALIZED:
  'inventory.stock-level.initialized'` — added to `ROUTING_KEYS`
  (`libs/messaging/routing-keys.constants.ts`), the
  `MicroserviceMessagePatternEnum` (`libs/contracts/microservices/...`), and the
  value-for-value spec (`libs/messaging/spec/routing-keys.constants.spec.ts`). It
  is a **reserved surface** on `inventory_queue` (no cross-service consumer yet).

- **`IStockEventsPublisherPort`** gained
  `publishStockLevelInitialized(event: StockLevelInitializedEvent, correlationId?): Promise<void>`.

## Key decisions & deviations

- **No new ADR.** The cross-service delivery applies ADR-008 / ADR-020
  (producer-targets-consumer-queue, default exchange only) — the same pattern
  `inventory.stock.low → notification_events` uses. **No topic/fanout exchange**
  was introduced (that would need a superseding ADR). Documented in doc `05`.
- **`stock_level.version` is `1` on the auto-init INSERT path, not `0`.** TypeORM
  `@VersionColumn()` numbers from 1 on first insert (ADR-027 says persistence owns
  the value). The domain `StockLevel.initialAt(...)` sets in-memory `version: 0`,
  but the persisted/re-read row carries TypeORM's `1`. The seed
  (`stock-level.sql`) writes `version 0` via raw SQL, so seeded rows stay `0` —
  only the TypeORM `save` path bumps to `1`. The auto-init e2e asserts the three
  **quantity** columns are `0` (the meaningful zeroed invariant) and only that
  `version` is a number — **do not assert `version === 0` on a TypeORM-persisted
  stock level.** The unit spec (InMemory repo, no TypeORM) still asserts the
  domain-level `version 0`.
- **Auto-init does NOT invalidate the cache.** Per the task spec the use case only
  saves + emits; it does not wrap the save in `stockCache.withInvalidation(...)`.
  Consequence: if a caller reads a brand-new variant's stock **before** the
  consumer runs, the read path caches a `locations: []` (zero-availability) answer
  under `ris:inventory:stock:v2:<variantId>:__all__` that is **not** invalidated
  when the row is created — it self-heals at TTL (~60s) and on the first
  Receive/Adjust write (task-05, which goes through `withInvalidation`). This is
  functionally harmless (`totalAvailable` is `0` either way). **The auto-init e2e
  works around it by polling the DB directly** (proof the consumer ran) and only
  then issuing the HTTP GET (a clean cache miss). If task-05 wants the auto-init
  row to be immediately cache-consistent, route the save through
  `withInvalidation` — but weigh the added `STOCK_CACHE` dependency on the use
  case.
- **CLAUDE.md / README.md got surgical edits only** (the task-01/02/03 precedent —
  the full inventory rewrite is task-06): CLAUDE.md RabbitMQ-queues paragraph, the
  inventory + catalog message-pattern bullets, the catalog-module bullet (now
  imports `MicroserviceClientInventoryModule`, two-client publisher), and the
  cross-service-events note. README.md services table (inventory + catalog rows)
  and the superseded-inventory-tree disclaimer (now notes the consumer landed).
  **The README ASCII topology diagram boxes were left for the task-06 holistic
  pass** (carryover-03 already deferred the inventory box; the catalog box still
  reads `Emits: variant.created` without showing it now targets `inventory_queue`).
- **No `http/*.http` change** — this task added no gateway endpoint (the consumer
  is RMQ; the variant-stock GET already shipped in task-03).

## Known gaps / deferrals

- **Receive / Adjust write operations + their events + `inventory.stock.low`
  wiring + lazy re-init of the `stock_level` row on first write → task-05.** Doc
  `05` forward-links `06-receive-and-adjust-use-cases.md` (not yet written) for the
  lazy-re-init path. `withInvalidation` (built task-02) is still unused.
- **Full inventory rewrite of README.md (the superseded `StockItem`/`product_stock`
  layout tree + the ASCII topology boxes) + the CLAUDE.md inventory-microservice
  `StockItem` bullet + doc `08` → task-06.**
- **`inventory.stock-level.initialized` has no consumer** (reserved surface — a
  later audit/projection capability).
- **`ProductStockActionEnum`** (in
  `libs/contracts/inventory/product-stock/product-stock.types.ts`) is still dead
  exported code (inherited from task-01).
- **Reservation/allocation + no-oversell enforcement of `version` → a later
  inventory-reservation capability.**

## Files added / modified

**Added:**
`apps/inventory-microservice/src/modules/stock/application/use-cases/auto-init-stock-level.use-case.ts`
(+ `spec/auto-init-stock-level.use-case.spec.ts`);
`.../stock/infrastructure/consumers/catalog-events.consumer.ts` (+ `index.ts`);
`.../stock/domain/events/stock-level-initialized.event.ts`;
`libs/contracts/inventory/events/stock-level-initialized.event.ts`;
`test/inventory-auto-init.e2e-spec.ts`;
`test/data-source/inventory-auto-init.e2e-spec.data-source.ts`;
`docs/implementation/04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md`.

**Modified:**
`.../stock/domain/events/index.ts`; `.../stock/application/use-cases/index.ts`;
`.../stock/application/ports/stock-events.publisher.port.ts`;
`.../stock/infrastructure/messaging/stock-rabbitmq.publisher.ts`;
`.../stock/infrastructure/stock.module.ts`;
`apps/catalog-microservice/.../catalog/infrastructure/messaging/catalog-rabbitmq.publisher.ts`;
`apps/catalog-microservice/.../catalog/catalog.module.ts`;
`libs/contracts/inventory/events/index.ts`;
`libs/messaging/routing-keys.constants.ts` (+ `spec/routing-keys.constants.spec.ts`);
`libs/contracts/microservices/microservice-message-pattern.enum.ts`;
`README.md`, `CLAUDE.md`.

**Deleted:** none.

## How to verify (all run green this session)

```bash
yarn lint                 # exit 0 (--max-warnings 0)
yarn test:unit            # 68 suites, 482 tests pass (was 67/478 in task-03; +1 suite / +4 tests: auto-init use-case spec)
yarn build                # all 5 apps compile
yarn test:e2e             # reload + seed + 9 suites / 90 tests pass (was 8/88 in task-03; +1 suite / +2 tests: inventory-auto-init)
grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md   # CLEAN (exit 1)

# Live async-consumer check (docker compose up -d; yarn migration:run; yarn test:seed;
# yarn start:dev — catalog + inventory + gateway all up):
#   1. Create a product, then a variant (admin bearer):
#        POST /api/catalog/products            -> { id: <productId> }
#        POST /api/catalog/products/<productId>/variants  -> { id: <newVariantId> }
#   2. Poll the public read until the default-warehouse entry appears (consumer is async):
curl -s http://localhost:3000/api/inventory/variants/<newVariantId>/stock | jq
#      -> totalOnHand 0, totalAvailable 0, one default-warehouse entry (0/0/0)
#   NOTE: if you curl the GET *before* the consumer runs you cache a `locations: []`
#   answer for ~60s (auto-init does not invalidate) — read after the row exists.
#   3. Redis key after a post-row read:
redis-cli --scan 'ris:inventory:stock:v2:<newVariantId>:*'   # ris:inventory:stock:v2:<id>:__all__
```
