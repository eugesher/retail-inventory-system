# Carryover 05 — Receive Stock + Adjust Stock operations, events, gateway POST endpoints

> Read this before starting task-06 (after `carryover-01..04.md`). It records the
> on-disk state task-05 left behind. (This file lives under `tmp/`; the
> self-containment rule does not apply here.)

## Entry state for task-06

- **The inventory microservice now has two Stage-1 write operations** on the new
  model, both transport/ORM-free (ADR-004/017):
  - `ReceiveStockUseCase`
    (`apps/inventory-microservice/.../stock/application/use-cases/receive-stock.use-case.ts`).
    Input `IStockReceivePayload` `{ variantId; stockLocationId?; quantity; actorId?;
    correlationId? }`. Validates `quantity` positive int (`STOCK_RECEIVE_QUANTITY_INVALID`),
    requires the location to exist + be active, then inside
    `stockCache.withInvalidation(work, resolveItems, { correlationId })` runs
    `transactionPort.runInTransaction(find-or-initialAt → changeOnHand(+quantity) →
    saveStockLevel)`. `resolveItems` → `[{ variantId, stockLocationId }]`. Emits
    `inventory.stock.received` post-commit (best-effort). Returns the single-location
    `StockLevelView`. No low-stock check (receive never lowers on-hand).
  - `AdjustStockUseCase` (`.../adjust-stock.use-case.ts`). Input `IStockAdjustPayload`
    `{ variantId; stockLocationId?; quantityDelta; reasonCode; actorId?; correlationId? }`.
    Validates `quantityDelta` non-zero int (`STOCK_ADJUSTMENT_DELTA_INVALID`) +
    `reasonCode` non-empty (`STOCK_ADJUSTMENT_REASON_REQUIRED`), requires active
    location, then same `withInvalidation` → tx → find-or-initialAt → `changeOnHand(delta)`
    (rejects below-zero **before save** with `STOCK_RESULT_NEGATIVE`) → save. Emits
    `inventory.stock.adjusted` post-commit; then `inventory.stock.low` iff post-commit
    `quantityOnHand <= INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`. Returns `StockLevelView`.
  - Both default `stockLocationId` → `INVENTORY_DEFAULT_STOCK_LOCATION`
    (`'default-warehouse'`). Both registered in `StockModule.providers`.

- **`StockLevel.changeOnHand` now throws a typed `InventoryDomainException`** on the
  below-zero case (code `STOCK_RESULT_NEGATIVE`); the message still contains the word
  "negative" so the pre-existing model spec's `.toThrow('negative')` still passes. The
  non-integer-delta guard + the constructor `requireNonNegativeInt` checks stay plain
  `Error` (defensive backstops, → 500).

- **NEW: `InventoryDomainException` + `InventoryErrorCodeEnum`** — the inventory
  context's first concrete `DomainException` (third in the repo, after catalog +
  pricing). At `apps/inventory-microservice/.../stock/domain/inventory.exception.ts`,
  barrelled from `domain/index.ts`. Codes:
  `STOCK_RECEIVE_QUANTITY_INVALID` (400), `STOCK_ADJUSTMENT_DELTA_INVALID` (400),
  `STOCK_ADJUSTMENT_REASON_REQUIRED` (400), `STOCK_LOCATION_NOT_FOUND` (404),
  `STOCK_LOCATION_INACTIVE` (409), `STOCK_RESULT_NEGATIVE` (409).

- **NEW: `InventoryRpcExceptionFilter`** (presentation,
  `.../stock/presentation/inventory-rpc-exception.filter.ts`) — total `Record`
  mapping each code → HTTP status, terminates into `{ statusCode, message, code }`
  (the catalog/pricing pattern; the gateway `throwRpcError` reads `statusCode`).
  Registered via `{ provide: APP_FILTER, useClass: InventoryRpcExceptionFilter }` in
  `StockModule`. A new `presentation/index.ts` barrel exports the controller + filter
  (the module now imports `{ InventoryRpcExceptionFilter, StockController } from '../presentation'`).

- **NEW domain events** `StockReceivedEvent`, `StockAdjustedEvent`
  (`.../stock/domain/events/`, barrelled). **`StockLowEvent` reshaped** to key on
  `variantId` (`aggregateId`) + `stockLocationId` (was `productId`/`storageId`);
  same `quantity`/`threshold`.

- **NEW wire events** in `libs/contracts/inventory/events/` (barrelled):
  - `IInventoryStockReceivedEvent extends ICorrelationPayload`:
    `{ variantId, stockLocationId, quantityDelta, newOnHand, actorId?, eventVersion: 'v1', occurredAt }`.
  - `IInventoryStockAdjustedEvent extends ICorrelationPayload`:
    `{ variantId, stockLocationId, quantityDelta, reasonCode, newOnHand, actorId?, eventVersion: 'v1', occurredAt }`.
  - **`IInventoryStockLowEvent` RESHAPED** to
    `{ variantId, stockLocationId, quantity, threshold, eventVersion: 'v1', occurredAt, correlationId }`
    (was `{ productId, storageId, quantity, threshold, occurredAt, correlationId }`).

- **NEW RPC payload contracts** `libs/contracts/inventory/stock/` (barrelled):
  `IStockReceivePayload`, `IStockAdjustPayload` (double as the use-case inputs).

- **NEW routing keys** in `libs/messaging/routing-keys.constants.ts` (+ mirrored in
  `MicroserviceMessagePatternEnum`, + asserted in the value-for-value spec):
  - `INVENTORY_STOCK_RECEIVED: 'inventory.stock.received'` (event, `inventory_queue`, reserved)
  - `INVENTORY_STOCK_ADJUSTED: 'inventory.stock.adjusted'` (event, `inventory_queue`, reserved)
  - `INVENTORY_STOCK_LEVEL_RECEIVE: 'inventory.stock-level.receive'` (RPC, gateway→inventory)
  - `INVENTORY_STOCK_LEVEL_ADJUST: 'inventory.stock-level.adjust'` (RPC, gateway→inventory)

- **`IStockEventsPublisherPort` + `StockRabbitmqPublisher`** gained
  `publishStockReceived` / `publishStockAdjusted` (emitted via the
  `INVENTORY_MICROSERVICE` client → `inventory_queue`). `publishStockLow` mapping
  updated to the reshaped payload (still via the `NOTIFICATION_MICROSERVICE` client →
  `notification_events`). `publishStockReserved` stays a no-op.

- **`StockController`** now has 5 `@MessagePattern` handlers: the two reads, the two
  new writes (`handleStockReceive` / `handleStockAdjust`), and the
  `inventory.order.confirm` deprecation stub.

- **Notification side reshaped** (deliberate cross-service contract update):
  `send-low-stock-alert.use-case.ts` reads `event.variantId` / `event.stockLocationId`
  (was `productId`/`storageId`); message text/behaviour unchanged. Its spec updated to
  the new fields. The consumer (`inventory-events.consumer.ts`) needed no change (it
  passes the event through). `test/notification.e2e-spec.ts` does **not** assert
  stock-low fields, so it was untouched.

- **Gateway `inventory` module** now fronts the writes:
  - Port `IInventoryGatewayPort` gained `receiveStock(IReceiveStockCommand, cid)` /
    `adjustStock(IAdjustStockCommand, cid)` (both return `StockLevelView`); commands
    omit `correlationId` (adapter stitches it).
  - Adapter sends `INVENTORY_STOCK_LEVEL_RECEIVE` / `INVENTORY_STOCK_LEVEL_ADJUST`.
  - Use cases `ReceiveStockUseCase` / `AdjustStockUseCase` (gateway-side, thin,
    `throwRpcError` on catch). Registered in `inventory.module.ts`.
  - DTOs `ReceiveStockRequestDto` (`quantity` `@IsInt @IsPositive`, `stockLocationId?`)
    + `AdjustStockRequestDto` (`quantityDelta` `@IsInt @NotEquals(0)`, `reasonCode`
    `@IsString @IsNotEmpty`, `stockLocationId?`).
  - Controller routes (both `@RequiresPermission(INVENTORY_ADJUST)` + `@ApiBearerAuth()`
    + `@HttpCode(200)`), passing `actorId: actor.id` from `@CurrentUser()`:
    - `POST /api/inventory/variants/:variantId/stock/receive`
    - `POST /api/inventory/variants/:variantId/stock/adjust`

## Key decisions & deviations

- **No new ADR** — the work applies existing ADRs (write-then-invalidate ADR-023;
  best-effort post-commit emit ADR-020; staff-only gate ADR-024; typed domain
  exception + presentation filter the catalog/pricing pattern ADR-025/026; threshold
  constant ADR-012 §low-stock). Doc `06-receive-and-adjust-use-cases.md` written.
- **The transaction is structurally present but does not yet scope the repository
  ops.** The new `IStockRepositoryPort` methods (`findStockLevel`/`saveStockLevel`)
  take no `ITransactionScope`, so the `runInTransaction` wrapper currently runs an
  (effectively empty) DB transaction while the single-row save auto-commits on the
  repo's own connection. This is faithful to the task's prescribed structure and
  gives the correct **post-commit ordering** (`work()` resolves after the save is
  durable, then `withInvalidation` fires the prefix delete). When the later
  reservation capability makes the repo scope-aware, the wrapper becomes a real
  atomic boundary with **no use-case change**. Documented inline + in doc `06`.
- **Post-commit emits are best-effort** (try/catch warn-swallow) — a publish failure
  does not fail the already-committed write (ADR-020), diverging from auto-init which
  awaits the emit directly (auto-init is an event consumer; receive/adjust are RPCs
  returning a value).
- **Shared test-doubles extended:** `apps/.../stock/application/use-cases/spec/test-doubles.ts`
  gained `ImmediateTransactionPort`, `RecordingStockEventsPublisher` (records all 5
  publish methods), and `silentLogger` (plain no-ops, **not** `jest.fn()` — the file
  is non-`.spec.ts` and is compiled by the production webpack build, which forbids
  `jest`). The auto-init spec was refactored to use the shared
  `RecordingStockEventsPublisher` + `silentLogger` (its inline copies were removed).
- **CLAUDE.md / README.md got surgical edits only** (the task-01..04 precedent — the
  full inventory rewrite is task-06): the inventory + gateway-inventory message-pattern
  bullets, the cross-service-events note, the README route box / `### Inventory` API
  section / gateway layout tree. The README **"Caching" section (~line 723) still
  describes the superseded `GetStockUseCase`/`SUM` model** behind its disclaimer →
  task-06.

## Known gaps / deferrals

- **task-06 is the only remaining work:** the full README/CLAUDE inventory rewrite
  (the "Caching" section + the inventory-microservice `StockItem`/`product_stock`
  layout tree + the ASCII topology boxes), doc `08`, the architecture-lint fixture
  re-verify, and the final self-containment grep.
- **`StockMovement` / audit ledger is NOT written** — `reasonCode` lives on the
  `inventory.stock.adjusted` event + logs only. Deferred to the later
  inventory-reservation / audit-log capability.
- **Reservation / allocation / commit-sale / cancel / restock / transfer** + the
  no-oversell **`version`** enforcement → the later inventory-reservation capability.
  `StockLevel` still exposes only `changeOnHand`.
- **`inventory.stock.received` / `.adjusted` / `.stock-level.initialized`** are
  reserved surfaces on `inventory_queue` (no cross-service consumer yet).
- **`ProductStockActionEnum`** (in `libs/contracts/inventory/product-stock/product-stock.types.ts`)
  is still dead exported code (inherited from task-01).

## How to verify (all run green this session)

```bash
yarn lint                 # exit 0 (--max-warnings 0)
yarn build                # all 5 apps compile
yarn test:unit            # 71 suites, 506 tests pass (was 68/482 in task-04; +3 suites:
                          #   receive-stock, adjust-stock, inventory-rpc-exception.filter)
yarn test:e2e             # reload + seed + 11 suites / 94 tests pass (was 9/90 in task-04;
                          #   +2 suites: inventory-receive-and-adjust, inventory-cache)
grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md   # CLEAN (exit 1)
```

`http/inventory.http` (run the `login` block first to capture `@accessToken`; the
write requests use the admin token — admin holds `inventory:adjust`; the seeded
`warehouse@example.com`/`warehouse1234` warehouse-staff also works). The full
write sequence against the seeded variant 1 (starts at 100 on hand):

```text
login                  -> POST /api/auth/staff/login       (admin)
listLocations          -> GET  /api/inventory/locations            (Bearer)
getVariantStockAllLocations -> GET /api/inventory/variants/1/stock  (public)
getVariantStockFiltered     -> GET .../variants/1/stock?locationIds=default-warehouse
receiveStock           -> POST .../variants/1/stock/receive {"quantity":50}            -> 200, on-hand 150
adjustStock            -> POST .../variants/1/stock/adjust  {"quantityDelta":-3,"reasonCode":"damaged"} -> 200, on-hand 147
adjustStockBelowZero   -> POST .../variants/1/stock/adjust  {"quantityDelta":-100000,"reasonCode":"damaged"} -> 409
```

These exact gateway routes + payloads (receive 50, adjust −3, adjust −100 → 409,
403 without `inventory:adjust`, and the post-commit-cache read) are exercised
automatically by `test/inventory-receive-and-adjust.e2e-spec.ts` +
`test/inventory-cache.e2e-spec.ts`, which boot the gateway + inventory + catalog
microservices in-process with the same global `ValidationPipe` and `api` prefix.

## Files added / modified

**Added:**
`apps/inventory-microservice/.../stock/domain/inventory.exception.ts`;
`.../stock/domain/events/stock-received.event.ts`, `.../stock-adjusted.event.ts`;
`.../stock/application/use-cases/receive-stock.use-case.ts`, `.../adjust-stock.use-case.ts`
(+ `spec/receive-stock.use-case.spec.ts`, `spec/adjust-stock.use-case.spec.ts`);
`.../stock/presentation/inventory-rpc-exception.filter.ts`, `.../presentation/index.ts`
(+ `presentation/spec/inventory-rpc-exception.filter.spec.ts`);
`libs/contracts/inventory/events/stock-received.event.ts`, `.../stock-adjusted.event.ts`;
`libs/contracts/inventory/stock/stock-receive.payload.ts`, `.../stock-adjust.payload.ts`;
`apps/api-gateway/.../inventory/application/use-cases/receive-stock.use-case.ts`,
`.../adjust-stock.use-case.ts`;
`apps/api-gateway/.../inventory/presentation/dto/receive-stock.dto.ts`, `.../adjust-stock.dto.ts`;
`test/inventory-receive-and-adjust.e2e-spec.ts`, `test/inventory-cache.e2e-spec.ts`;
`docs/implementation/04-inventory-stock-level-and-location/06-receive-and-adjust-use-cases.md`.

**Modified:**
`apps/inventory-microservice/.../stock/domain/stock-level.model.ts` (typed below-zero throw);
`.../stock/domain/events/stock-low.event.ts` (reshape), `.../events/index.ts`, `.../domain/index.ts`;
`.../stock/application/use-cases/index.ts`, `.../application/ports/stock-events.publisher.port.ts`;
`.../stock/application/use-cases/spec/test-doubles.ts`, `.../spec/auto-init-stock-level.use-case.spec.ts`;
`.../stock/infrastructure/messaging/stock-rabbitmq.publisher.ts`, `.../infrastructure/stock.module.ts`;
`.../stock/presentation/stock.controller.ts`;
`apps/notification-microservice/.../application/use-cases/send-low-stock-alert.use-case.ts`
(+ its spec);
`libs/contracts/inventory/events/{stock-low.event,index}.ts`,
`libs/contracts/inventory/stock/index.ts`;
`libs/messaging/routing-keys.constants.ts` (+ `spec/routing-keys.constants.spec.ts`);
`libs/contracts/microservices/microservice-message-pattern.enum.ts`;
`apps/api-gateway/.../inventory/application/ports/inventory-gateway.port.ts`,
`.../application/use-cases/index.ts`,
`.../infrastructure/messaging/inventory-rabbitmq.adapter.ts`,
`.../presentation/inventory.controller.ts`, `.../presentation/dto/index.ts`,
`.../inventory.module.ts`;
`http/inventory.http`; `README.md`; `CLAUDE.md`.

**Deleted:** none.
