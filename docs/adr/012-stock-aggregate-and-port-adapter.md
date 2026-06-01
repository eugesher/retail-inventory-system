# ADR-012: Stock aggregate and the inventory port/adapter split

- **Date**: 2026-05-13
- **Status**: Accepted (cache port + adapter generalized by [ADR-016](016-cache-aside-generalized.md) → [ADR-021](021-cache-single-flight-and-ttl-jitter.md) → [ADR-022](022-cache-keys-tenant-and-schema-version.md) → [ADR-023](023-cache-invalidate-post-commit-by-type.md); fourth `ITransactionPort` added to ring-fence `ARCH-LINT-EX-01`; see References)

---

## Context

Before the inventory microservice's hexagonal migration it was on the legacy flat layout:

- `apps/inventory-microservice/src/app/api/product-stock/`
  - `product-stock.controller.ts` — `@MessagePattern` handlers.
  - `providers/product-stock-get.service.ts` — RPC for `inventory.product-stock.get`.
  - `providers/product-stock-order-confirm.service.ts` — RPC for `inventory.order.confirm`.
- `apps/inventory-microservice/src/app/common/modules/product-stock-common/`
  - `product-stock-common.service.ts` — façade with cache-aside read, locked-read aggregation, ledger append, and SCAN+UNLINK invalidation.
  - `providers/product-stock-common-{get,add,cache}.service.ts` — sub-providers each owning one cross-cutting concern.
- `apps/inventory-microservice/src/app/common/entities/` — `Product`, `ProductStock`, `ProductStockAction`, `Storage` TypeORM entities.

ADR-002 set the cache-aside contract for product-stock; ADR-004 declared
hexagonal-per-service as the target layout; ADR-011 elected the notification
microservice as the canonical per-module template. This work reshapes the
inventory microservice in that template, preserving every audit-flagged
behavior from ADR-002 verbatim. There is only one bounded context to
migrate today — `stock` — so this ADR is scoped to that single aggregate.

## Decision

### 1. Single `stock` bounded context, named after the aggregate

**Chosen.** The new module lives at
`apps/inventory-microservice/src/modules/stock/`. The name follows the
domain aggregate (`Stock` / `StockItem`), not the join name
`product-stock`. The join name persists in the table (`product_stock`) and
the entity (`ProductStock`) because renaming MySQL tables and entities
out from under existing data is risky and gains nothing the rename of the
module doesn't already give.

### 2. Domain layer

- `StockItem` is a pure class (not an `AggregateRoot<TId>` subclass — see §6
  for the rationale on emitting events from the use case rather than the
  aggregate). The constructor enforces:
  - `quantity >= 0`
  - `reservedQuantity >= 0`
  - `reservedQuantity <= quantity`
- `Storage` is a `ValueObject<{ id: string }>` from `@retail-inventory-system/ddd`.
  Equality is structural; the constructor rejects empty strings.
- Three in-process domain events extend `DomainEvent<number>`:
  `StockReservedEvent`, `StockReleasedEvent`, `StockLowEvent`.

`reservedQuantity` is in the domain even though the persistence layer is
still a single signed ledger (`product_stock`). The reservation invariant
belongs in the domain, not the adapter; a future ledger evolution (a
dedicated reservations column or a separate ledger) becomes invisible to
callers.

### 3. Three application ports, three concrete adapters

- `IStockRepositoryPort` (DI symbol `STOCK_REPOSITORY`) — inbound persistence.
  Methods: `findById`, `findBySku`, `aggregateForProduct`,
  `lockedTotalsByProduct`, `appendDeltas`, `save`. Adapter:
  `StockTypeormRepository` (extends `BaseTypeormRepository` from
  `@retail-inventory-system/database`).
- `IStockCachePort` (DI symbol `STOCK_CACHE`) — stock-specific cache port,
  hides the cache-key shape from use cases. Adapter: `StockRedisCache`,
  which reaches through `@nestjs/cache-manager` + `@keyv/redis` and
  preserves the ADR-002 SCAN+UNLINK contract verbatim (named-key
  fallback for non-Redis backends).
- `IStockEventsPublisherPort` (DI symbol `STOCK_EVENTS_PUBLISHER`) — outbound
  event emission. Adapter: `StockRabbitmqPublisher`, which wraps
  `ClientProxy.emit()` and the `firstValueFrom` materialization, so
  application code awaits a plain Promise and never touches RxJS.

The cache port is intentionally stock-specific (rather than reusing the
generic `CACHE_PORT` from `libs/cache` directly) because the existing
SCAN+UNLINK invalidation, KeyvRedis namespace handling, and graceful-
degradation `try/catch` reach below the generic port's surface. The cache-generalization work
revisits the cache generalization; until then the audit-flagged behavior
lives in the stock module's adapter, not the use cases.

### 4. Use cases mirror the legacy `*.service.ts` files

| Legacy class | New use case |
|---|---|
| `ProductStockGetService` + `ProductStockCommonService.get` | `GetStockUseCase` |
| `ProductStockOrderConfirmService` | `ReserveStockForOrderUseCase` |
| `ProductStockCommonAddService` + `ProductStockCommonService.add` | `AddStockUseCase` |

The cache-aside read path, the transactional reserve path, the
post-commit fire-and-forget invalidation, the `AUDIT-2026-05-08
[CACHE-001/CODE-001]` annotations — all preserved verbatim in the new
use cases. Only the file layout and the *shape* of the abstractions
change.

`AddStockUseCase` is kept internal-only today (used by
`ReserveStockForOrderUseCase` indirectly through the repository). A future
admin or batch importer can depend on the use case rather than the
repository port.

### 5. Low-stock threshold lives in `libs/contracts/inventory/inventory.constants.ts`

**Chosen.** Added `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD = 5` alongside the
existing `INVENTORY_DEFAULT_STORAGE`. The threshold is read from
`@retail-inventory-system/contracts` so the notification microservice (which
already receives `threshold` on the wire via `IInventoryStockLowEvent`)
can use the same value if it needs to. An env-only setting would have
required tighter coupling to `ConfigService` inside the use case; a
column on `product_stock` would have made the threshold mutable but
introduced migration work for no current benefit. A constant is the
smallest commitment that satisfies the contract today.

### 6. Events emit from the use case, not the aggregate

**Chosen.** The use case constructs `StockLowEvent` instances after the
transaction commits and forwards them to the publisher port. The
`StockItem` aggregate does not extend `AggregateRoot`; there is no
`pullDomainEvents()` to drain.

Rationale: the legacy `ProductStockOrderConfirmService` already emitted
its post-commit-invalidate call from the service, not from an aggregate.
Promoting the event recording into the aggregate would require
materializing a `StockItem` per ledger row before recording the event,
which is wasted allocation for a path that produces only signed deltas.
A future evolution can promote the aggregate to `AggregateRoot` if the
domain logic grows; until then the use-case-level emission keeps the
codepath proportional to the work it actually does.

### 7. Reserved exchange constant remains unused

`EXCHANGES.NOTIFICATION` in `libs/messaging` is still reserved (today the
`notification_events` queue is bound to the default exchange). The
inventory publisher emits onto the notification client's
`NOTIFICATION_MICROSERVICE` ClientProxy, which targets the queue
directly. Topic-exchange routing is a follow-up if multiple consumers of
`inventory.stock.low` are ever needed.

### 8. Cache audit annotations preserved verbatim

Every `AUDIT-2026-05-08 [CACHE-NNN]` and `AUDIT-2026-05-08 [CODE-NNN]`
comment from the legacy code travels with its production line into the
new module. Line numbers update where the surrounding code moved, but
the textual content and the audit identifier do not. The cache-generalization work owns the
generalization pass for these items; this ADR explicitly does not.

## Consequences

- Inventory now matches the notification module's per-module hexagonal
  shape. The boundary rule "`ClientProxy` only inside
  `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`" is
  satisfied by the publisher adapter.
- The legacy `app/api/` and `app/common/` folders are deleted; their
  TypeORM entities are relocated under
  `modules/stock/infrastructure/persistence/`.
- A new `MicroserviceClientNotificationModule` joins the existing
  Retail and Inventory client modules in `libs/messaging`; inventory
  uses it to emit `inventory.stock.low` to the notification queue.
- The seven verification gates (yarn install/build/lint/test:unit,
  yarn test:e2e on the inventory paths, `@Entity` location grep, no
  direct `Repository<...>` injection outside the typeorm adapter) all
  pass.

## Alternatives considered

1. **Skip the stock-specific cache port; inject `CACHE_PORT` directly into the use case.** Rejected because the SCAN+UNLINK invalidation and KeyvRedis namespace handling reach below the generic port. The right place to generalize is the dedicated cache-generalization work.
2. **Promote `StockItem` to `AggregateRoot` and emit `StockLowEvent` from within the aggregate.** Rejected as premature — see §6. Easy to revisit if domain logic grows.
3. **Put the low-stock threshold on the `product_stock` row.** Rejected as a migration cost with no current benefit. Easy to lift to the column later by keeping the threshold lookup behind the use case (the constant is referenced in one place).
4. **Keep emitting `inventory.stock.low` via a fan-out exchange.** Deferred. Today's single-consumer model (notification queue) is sufficient.

## References

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — the
  per-module hexagonal target this module realizes.
- [ADR-011](011-notifier-port-and-adapters.md) — the canonical
  per-module template this module follows.
- [ADR-002](002-redis-cache-aside-product-stock.md) /
  [ADR-016](016-cache-aside-generalized.md) — the cache-aside
  contract the stock cache adapter preserves and generalizes.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — the
  TypeORM/MySQL stack `StockTypeormRepository` builds on.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — the broker the
  `inventory.stock.low` publisher emits onto.

### Forward-supersession pointers

The five bullets below catalogue the drift between this ADR's §3 / §4 / §8
prose and the live code. Per ADR-003's immutability rule the §3 / §4 / §8
text stays intact above; the pointers here are the forward graph a reader
follows when the historical prose disagrees with the source of truth.

- **§3 cache adapter name.** Live class is `StockCache` at
  `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`.
  The `Redis` qualifier was dropped when the adapter stopped reaching
  `@nestjs/cache-manager` / `@keyv/redis` directly (next bullet); the file
  is `stock.cache.ts`, not `stock-redis.cache.ts`.
- **§3 cache adapter mechanism ("reaches through `@nestjs/cache-manager` +
  `@keyv/redis`").** Generalized by
  [ADR-016](016-cache-aside-generalized.md) — the adapter now delegates to
  `CACHE_PORT` from `@retail-inventory-system/cache`. Direct imports of
  `@nestjs/cache-manager`, `@keyv/redis`, or `cacheable` from any
  `apps/*/src` file are forbidden per CLAUDE.md §"Cache-key convention"
  (verification gate: `grep -rE 'redis|cache-manager|keyv' apps/*/src` must
  return zero matches).
- **§3 "preserves the ADR-002 SCAN+UNLINK contract verbatim + named-key
  fallback for non-Redis backends".** Replaced in two steps:
  [ADR-016](016-cache-aside-generalized.md) added the `delByPrefix`
  primitive to `ICachePort`, and
  [ADR-023](023-cache-invalidate-post-commit-by-type.md) made the
  post-commit ordering type-enforced via `IStockCachePort.withInvalidation`
  (the public `invalidate(...)` is gone). The named-key fallback for
  non-Redis backends is now the responsibility of the concrete `CACHE_PORT`
  adapter (`RedisCacheAdapter` in `libs/cache`, or a future non-Redis
  adapter), not `StockCache`.
- **§3 "three application ports".** The stock module's
  `application/ports/` directory now has four files —
  `stock.repository.port.ts`, `stock-cache.port.ts`,
  `stock-events.publisher.port.ts`, and `transaction.port.ts`. The fourth
  was introduced to ring-fence the `ARCH-LINT-EX-01` `EntityManager`-leak
  exception documented in CLAUDE.md §"Operational notes"; `IStockRepositoryPort`
  method signatures now take an optional `scope?: ITransactionScope`
  instead of a raw `EntityManager`. The exception is partially closed —
  `ITransactionPort` is in place, but removing the inline `@InjectEntityManager`
  / `EntityManager` ESLint disables in the repository + use-case lock-step
  remains pending.
- **§4 / §8 "post-commit fire-and-forget invalidation" + "`AUDIT-2026-05-08
  [CACHE-NNN]` annotations preserved verbatim".** Both superseded by the
  generalization pass §8 forecast. Audit closures: CACHE-006 / CACHE-010
  / CACHE-011 / CACHE-012 by [ADR-016](016-cache-aside-generalized.md);
  CACHE-001 / CACHE-004 by [ADR-021](021-cache-single-flight-and-ttl-jitter.md);
  CACHE-003 / CACHE-009 by [ADR-022](022-cache-keys-tenant-and-schema-version.md);
  CACHE-002 by [ADR-023](023-cache-invalidate-post-commit-by-type.md)
  (post-commit ordering type-enforced — no public `invalidate`, no
  fire-and-forget); CACHE-005 by the `available` flag on
  `IStockCachePort.get`'s return shape (a Redis-down read collapses the
  per-request warn count from three to one). The closure register is in
  CLAUDE.md §"Operational notes"; the only `AUDIT-2026-05-08` annotation
  surviving in the stock module today is `[CODE-001]` inside
  `reserve-stock-for-order.use-case.ts`.
