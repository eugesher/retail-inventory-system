# _carryover-08.md — Align Inventory service to hexagonal layout (Phase 8)

> Generated 2026-05-13 by the task-08 session on branch
> `RIS-32-Architecture-migration-Phase-8-Align-Inventory-service-to-hexagonal-layout`.
> The next task (`task-09`) reads this file as its first action and fails fast
> if it is missing.

## 1. Entry-gate result

`yarn install`, `yarn build` (4 apps), `yarn lint`, `yarn test:unit` (96 tests
across 20 suites) were all green at the start of the session. Baseline matches
`_carryover-07.md`'s reported state.

## 2. File-rename map (legacy → new)

### Source files

| Legacy path | New path |
|---|---|
| `apps/inventory-microservice/src/app/api/product-stock/product-stock.controller.ts` | `apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts` |
| `apps/inventory-microservice/src/app/api/product-stock/product-stock.module.ts` | replaced by `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts` |
| `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-get.service.ts` | `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts` |
| `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-order-confirm.service.ts` | `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts` |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/product-stock-common.service.ts` | folded into `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts` (read-path cache-aside flow) |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-add.service.ts` | folded into `StockTypeormRepository.appendDeltas` + `AddStockUseCase` |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-get.service.ts` | folded into `StockTypeormRepository.aggregateForProduct` + `lockedTotalsByProduct` |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts` | `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock-redis.cache.ts` |
| `apps/inventory-microservice/src/app/common/entities/product.entity.ts` | `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts` |
| `apps/inventory-microservice/src/app/common/entities/product-stock.entity.ts` | `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts` |
| `apps/inventory-microservice/src/app/common/entities/product-stock-action.entity.ts` | `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock-action.entity.ts` |
| `apps/inventory-microservice/src/app/common/entities/storage.entity.ts` | `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/storage.entity.ts` |
| `apps/inventory-microservice/src/app/common/entities/index.ts` | replaced by `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/index.ts` (exports `stockEntities`) |

### Folders deleted

- `apps/inventory-microservice/src/app/api/` — gone.
- `apps/inventory-microservice/src/app/common/` — gone. `app/` retains only `app.module.ts` + `index.ts`.

### New cross-cutting files

| Path | Role |
|---|---|
| `libs/messaging/microservice-client-notification.module.ts` | New `MicroserviceClientNotificationModule`; binds `NOTIFICATION_MICROSERVICE` ClientProxy onto the `notification_events` queue. Re-exported from the lib barrel. |
| `libs/contracts/inventory/inventory.constants.ts` | Added `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD = 5` alongside the existing `INVENTORY_DEFAULT_STORAGE`. |

## 3. Use-case map (old `*.service.ts` → new `*.use-case.ts`)

| Legacy class | New class |
|---|---|
| `ProductStockGetService` | `GetStockUseCase` |
| `ProductStockOrderConfirmService` | `ReserveStockForOrderUseCase` |
| `ProductStockCommonAddService` (+ the `add` façade path on `ProductStockCommonService`) | `AddStockUseCase` (internal-only today; ledger insertion is reached through `IStockRepositoryPort.appendDeltas`) |
| `ProductStockCommonGetService` | folded into `StockTypeormRepository.aggregateForProduct` and `lockedTotalsByProduct` |
| `ProductStockCommonCacheService` | `StockRedisCache` adapter (implements `IStockCachePort`) |
| `ProductStockCommonService` (façade) | the orchestration responsibilities are now in `GetStockUseCase` (read-path) and `ReserveStockForOrderUseCase` (write-path); the façade class no longer exists |

The cache-aside read path, the locked-aggregate reserve path, the post-commit
fire-and-forget invalidation, and the `AUDIT-2026-05-08 [CACHE-001/CODE-001]`
annotations all travel into the new code verbatim.

## 4. New module files

```
apps/inventory-microservice/src/modules/stock/
  domain/
    stock-item.model.ts                    # quantity / reservedQuantity invariants; reserve/release
    storage.model.ts                       # ValueObject<{ id }>
    events/
      stock-low.event.ts                   # extends DomainEvent<number>
      stock-released.event.ts
      stock-reserved.event.ts
      index.ts
    index.ts
    spec/
      stock-item.model.spec.ts             # 11 invariant tests
      storage.model.spec.ts                # 4 VO tests
  application/
    ports/
      stock.repository.port.ts             # IStockRepositoryPort + STOCK_REPOSITORY
      stock-cache.port.ts                  # IStockCachePort + STOCK_CACHE
      stock-events.publisher.port.ts       # IStockEventsPublisherPort + STOCK_EVENTS_PUBLISHER
      index.ts
    use-cases/
      get-stock.use-case.ts
      reserve-stock-for-order.use-case.ts
      add-stock.use-case.ts
      index.ts
      spec/
        test-doubles.ts                    # InMemoryStockRepository / InMemoryStockCache / InMemoryStockEventsPublisher (jest-free)
        get-stock.use-case.spec.ts         # 7 tests
        reserve-stock-for-order.use-case.spec.ts  # 8 tests
        add-stock.use-case.spec.ts         # 2 tests
  infrastructure/
    persistence/
      product.entity.ts
      product-stock.entity.ts
      product-stock-action.entity.ts
      storage.entity.ts
      stock-item.mapper.ts
      stock-typeorm.repository.ts
      index.ts                             # exports `stockEntities` + symbols
      spec/
        stock-typeorm.repository.spec.ts   # 11 tests (aggregate, locked totals, append)
    cache/
      stock-redis.cache.ts                 # SCAN+UNLINK + named-key fallback
      index.ts
      spec/
        stock-redis.cache.spec.ts          # 14 tests
    messaging/
      stock-rabbitmq.publisher.ts          # wraps ClientProxy.emit + firstValueFrom
      index.ts
    stock.module.ts                        # binds STOCK_REPOSITORY/STOCK_CACHE/STOCK_EVENTS_PUBLISHER
  presentation/
    stock.controller.ts                    # @MessagePattern(ROUTING_KEYS.INVENTORY_PRODUCT_STOCK_GET / INVENTORY_ORDER_CONFIRM)
    dto/                                   # (empty — payload shapes still come from contracts)
```

## 5. Tests migrated / added

### Migrated (6 legacy specs replaced by new specs covering the same behavior)

| Legacy spec | New spec(s) |
|---|---|
| `apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-get.service.spec.ts` | `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/get-stock.use-case.spec.ts` |
| `apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-order-confirm.service.spec.ts` | `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/reserve-stock-for-order.use-case.spec.ts` |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/spec/product-stock-common.service.spec.ts` | folded into `get-stock.use-case.spec.ts` (cache-aside paths) + `reserve-stock-for-order.use-case.spec.ts` (invalidate delegation) |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-add.service.spec.ts` | `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/spec/stock-typeorm.repository.spec.ts` (`appendDeltas` describe block) + `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/add-stock.use-case.spec.ts` |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-get.service.spec.ts` | `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/spec/stock-typeorm.repository.spec.ts` (`aggregateForProduct` + `lockedTotalsByProduct` describes) |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-cache.service.spec.ts` | `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock-redis.cache.spec.ts` |

### Added

| Spec | Coverage |
|---|---|
| `apps/inventory-microservice/src/modules/stock/domain/spec/stock-item.model.spec.ts` | 11 tests — constructor invariants (`quantity >= 0`, `reservedQuantity <= quantity`), `reserve`/`release` paths |
| `apps/inventory-microservice/src/modules/stock/domain/spec/storage.model.spec.ts` | 4 tests — non-empty constructor, structural equality |

Final unit-test totals: **107 tests passing across 21 suites** (was 96 across
20 suites). Net new = 11 tests; the migration kept assertion-level coverage of
every legacy path and added the domain-invariant tests the task brief asked
for.

### Integration test against testcontainers

Deferred per the task instructions — `test:infra:up` does not support
container injection from a unit suite today, and the existing
`test/system-api.e2e-spec.ts` exercises the integration surface. No contract
drift identified that would slip past the E2E.

## 6. ADR-002 cache audit annotations

Preserved verbatim with their identifiers intact. Two travelled into
`reserve-stock-for-order.use-case.ts`:

- `AUDIT-2026-05-08 [CACHE-001]` — cache-aside read/write race window on the
  miss path.
- `AUDIT-2026-05-08 [CODE-001]` — unreachable `!!item.storageId` predicate
  kept for the forward-looking null-storage case.

Five travelled into `stock-redis.cache.ts`:

- `AUDIT-2026-05-08 [CACHE-004]` — no TTL jitter.
- `AUDIT-2026-05-08 [CACHE-005]` — double warn log on Redis outage.
- `AUDIT-2026-05-08 [CACHE-006]` — `cacheable` major-version-bump risk.
- `AUDIT-2026-05-08 [CACHE-012]` — best-effort fallback for non-Redis backends.

The pre-existing `CACHE-001..-012` items in `libs/cache/cache-keys.ts` did not
move (cache-key sorting bug, multi-tenant prefix, schema-version segment).
Line references inside the moved blocks were updated where the surrounding
code shifted; identifier strings (e.g. `CACHE-001`) were not renumbered.

Task-11 still owns the generalization pass for every audit-flagged item.

## 7. Deferred to task-11 (cache generalization)

- Single-flight on the cache-aside miss path (`AUDIT-2026-05-08 [CACHE-001]`).
- TTL jitter (`[CACHE-004]`).
- Outage short-circuit to suppress duplicate warn logs (`[CACHE-005]`).
- `cacheable` major-version pin (`[CACHE-006]`).
- Combo-key enumeration on the non-Redis fallback (`[CACHE-012]`).
- Stock-key cache-port generalization: today `StockRedisCache` reaches through
  `@nestjs/cache-manager` + `@keyv/redis` directly. The generic `CACHE_PORT`
  from `libs/cache` does not expose SCAN+UNLINK. Either widen the generic
  port or accept that stock keeps its own adapter (current state).

## 8. Deferred to task-10 (OTel)

- No span work in this task. The publisher path (`StockRabbitmqPublisher`) is
  a natural cache-trace seam — wrap `emit()` in a trace when the OTel
  shell fills in. Today the publisher only carries the `correlationId` field
  on the wire payload.

## 9. Unexpected findings

1. **`MicroserviceClientNotificationModule` did not exist.** Pre-task-08 only
   the Retail and Inventory client modules were registered in `libs/messaging`.
   Producing `inventory.stock.low` from the inventory microservice requires a
   ClientProxy whose queue option targets `notification_events`; I added
   the third client module alongside the existing two and exported it from
   the barrel. Task-09 (retail producing `retail.order.created`) will reuse
   this same module rather than adding a fourth.

2. **`BaseTypeormRepository.save` returns `TDomain`, not `void`.** My initial
   port draft declared `save(stockItem: StockItem): Promise<void>`, which
   broke the type contract inherited from `BaseTypeormRepository`. Aligned
   the port (and the adapter) to return `Promise<StockItem>` to match. No
   call sites exist today.

3. **`StockItem` was not made an `AggregateRoot` subclass.** The task brief
   describes `quantity >= 0` / `reservedQuantity <= quantity` invariants but
   does not require pull-based event drainage. Promoting it to
   `AggregateRoot` would force materializing a `StockItem` per ledger row
   before recording an event — wasted allocation for a path that only
   produces signed deltas. The use case emits `StockLowEvent` directly via
   the publisher port. ADR-012 §6 records the rationale.

4. **`IInventoryStockLowEvent.correlationId` is required, not optional.** The
   wire contract from `libs/contracts/inventory/events/stock-low.event.ts`
   makes `correlationId` required. The publisher adapter defaults to `''`
   when the use case passes `undefined`; the use case always threads the
   real correlation ID from the inbound RPC payload, so the empty-string
   branch should not fire in production. Task-09 should consider whether
   to relax the contract to optional or to enforce it at the publisher
   boundary.

5. **`tsconfig.app.json` excludes `**/*.spec.ts` only.** Sibling
   `test-doubles.ts` files inside `spec/` folders are still compiled into
   the production build; any reference to `jest.*` in them breaks the
   webpack build. Both the notification module's `test-doubles.ts` and
   the new stock module's `test-doubles.ts` therefore use pure-TypeScript
   class implementations of the ports; the `LoggerMock` factory remains
   inlined per spec file. Task-09 will hit the same constraint.

6. **Lint's `@typescript-eslint/unbound-method` triggers on `jest.Mocked<IPort>`
   property access.** When the port surface declares a method
   (`publishStockLow(...): Promise<void>`) and the spec asserts on the bare
   method reference (`expect(publisher.publishStockLow).toHaveBeenCalled()`),
   the linter rejects the unbound access. Workaround: declare the test
   mock as a structural type with `jest.Mock` fields and cast at the
   constructor call. Recorded so task-09 can apply the same pattern.

## 10. Verification results

```
$ yarn install
➤ YN0000: · Done in 2s 812ms

$ yarn build
webpack 5.106.0 compiled successfully in 9120 ms   # api-gateway
webpack 5.106.0 compiled successfully in 8559 ms   # inventory-microservice
webpack 5.106.0 compiled successfully in 9624 ms   # retail-microservice
webpack 5.106.0 compiled successfully in 9210 ms   # notification-microservice

$ yarn lint
# (no output — clean exit code 0)

$ yarn test:unit
Test Suites: 21 passed, 21 total
Tests:       107 passed, 107 total
Snapshots:   0 total

$ yarn test:e2e
Test Suites: 3 passed, 3 total
Tests:       35 passed, 35 total
Snapshots:   42 passed, 42 total

$ grep -r '@Entity' apps/inventory-microservice/src
apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock-action.entity.ts:3:@Entity('product_stock_action')
apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts:3:@Entity('product_stock')
apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts:9:@Entity('product')
apps/inventory-microservice/src/modules/stock/infrastructure/persistence/storage.entity.ts:3:@Entity('storage')

$ grep -r 'Repository<' apps/inventory-microservice/src --include="*.ts" | grep -v "\.spec\.ts" | grep -v "test-doubles"
apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts:27:  extends BaseTypeormRepository<ProductStock, StockItem>
apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts:32:    private readonly productStockRepository: Repository<ProductStock>,
```

Only the typeorm-repository adapter injects `Repository<ProductStock>`; all
entities live under `modules/stock/infrastructure/persistence/`. All seven
verification gates pass.

## 11. ADR numbers assigned

- **ADR-012** — Stock aggregate and the inventory port/adapter split. Status:
  Accepted. CLAUDE.md's "next free ADR" counter advanced to **013**.

## 12. Suggested adjustments to task-09 (retail/orders)

1. **Per-bounded-context modules.** Retail has more than one bounded context
   today (`order` is the main one; the order-product is a child entity of
   the order aggregate, not its own context). Treat `order` as the sole
   bounded context for now and put everything under
   `apps/retail-microservice/src/modules/order/`. If `customer` or any
   other context needs lifting later, do it as a follow-up.

2. **Order aggregate exists already.** `apps/retail-microservice/src/app/api/order/domain/order-confirm.domain.ts`
   is a pure-class domain helper (`OrderConfirmDomain`). It is the natural
   seed for a full `Order` aggregate under `modules/order/domain/`. The
   existing spec at `app/api/order/domain/spec/order-confirm.domain.spec.ts`
   should move alongside.

3. **`MicroserviceClientNotificationModule` is ready.** Retail does not
   need to add a new lib-side module — import the one task-08 added. The
   publisher binding for `retail.order.created` lives under
   `modules/order/infrastructure/messaging/order-rabbitmq.publisher.ts`
   (mirror the stock publisher's shape).

4. **`IRetailOrderCreatedEvent.correlationId` is required.** Same gotcha as
   §9 #4 above. The retail publisher should default to `''` for safety, but
   the use case always has the real correlation ID from the inbound RPC.

5. **Cold-observable gotcha is solved at the publisher boundary.** The new
   stock publisher wraps `ClientProxy.emit()` in `firstValueFrom`
   internally. Mirror that — application code awaits a plain Promise.

6. **`PinoLogger.assign` is HTTP-only.** Retail today uses
   `PinoLogger` without `assign`; the gotcha only bites if a use case is
   shared between HTTP and RMQ paths. None today.

7. **`tsconfig.app.json` excludes `*.spec.ts` only.** If you add
   `test-doubles.ts` sibling files (the test-double class implementations
   of the order ports), keep them jest-free or the production build fails.
   See §9 #5 above.

8. **`@typescript-eslint/unbound-method` on `jest.Mocked<IPort>`.** Apply the
   structural-mock + cast pattern from §9 #6 above to any spec that
   asserts on a port method reference.

9. **Threshold-style constants.** If retail needs a similar magic constant
   (e.g. an order auto-confirm window), put it in
   `libs/contracts/retail/retail.constants.ts` — same shape as
   `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD` in
   `libs/contracts/inventory/inventory.constants.ts`.

10. **Cache audit comments.** Retail does not have ADR-002-style cache
    coverage today. No audit annotations to preserve.

## 13. Open follow-ups (post-task-08)

1. **Topic-exchange migration.** `EXCHANGES.NOTIFICATION` in `libs/messaging`
   is still reserved but unused. Multi-consumer fan-out for
   `inventory.stock.low` is the obvious motivation; today the notification
   queue is bound to the default exchange and there is exactly one
   consumer.
2. **Cache port generalization.** See §7 — `StockRedisCache` reaches below
   the generic `CACHE_PORT` to do SCAN+UNLINK. Task-11 either widens the
   port or accepts the stock module's adapter as is.
3. **Producer for `retail.order.created`.** Task-09's deliverable.
4. **`findBySku` on `StockItem`.** Port surface includes it; the adapter
   returns `null` because the `product_stock` table has no SKU column. A
   future schema evolution lights it up without changing call-site code.
