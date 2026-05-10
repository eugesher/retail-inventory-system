# _carryover-04.md — Extract shared libs: integration (Phase 1, part 2)

> Generated 2026-05-10 by the task-04 session on branch
> `RIS-28-Architecture-migration-Phase-4-Extract-shared-libs-integration`.
> Entry-gate commit: `8743bfc` (the merge of task-03 into `main`).
> The next task (`task-05-align-api-gateway.md`) reads this file as
> its first action and fails fast if it is missing.

## 1. New lib files (paths + roles)

### `libs/messaging/`

| File | Role |
|------|------|
| `routing-keys.constants.ts` | `ROUTING_KEYS` const object — dotted `<service>.<aggregate>.<action>` strings. |
| `exchanges.constants.ts` | `EXCHANGES` const object reserving exchange names for future topic-routing migration. |
| `microservice-client.configuration.ts` | `MicroserviceClientConfiguration` — relocated verbatim from `libs/common/config/`. |
| `rabbitmq.client.factory.ts` | `RabbitmqClientFactory.create(configService, queue)` for one-off `ClientProxy`s in tests / bootstrap. |
| `microservice-client-inventory.module.ts` | `MicroserviceClientInventoryModule` — relocated. |
| `microservice-client-retail.module.ts` | `MicroserviceClientRetailModule` — relocated. |
| `messaging.module.ts` | `MessagingModule` — convenience aggregator that imports both client modules. |
| `index.ts` | Barrel; also re-exports `MicroserviceClientTokenEnum` and `MicroserviceQueueEnum` from contracts for caller convenience. |
| `spec/routing-keys.constants.spec.ts` | Wire-format alignment test: `ROUTING_KEYS` ≡ `MicroserviceMessagePatternEnum`. |

### `libs/cache/`

| File | Role |
|------|------|
| `cache.port.ts` | `ICachePort` interface + `CACHE_PORT` DI token. |
| `redis-cache.adapter.ts` | `RedisCacheAdapter` — `@Injectable()` implementation of `ICachePort` over `@nestjs/cache-manager`. |
| `cache-module.config.ts` | `cacheModuleConfig` — relocated verbatim from `libs/config/`. |
| `cache.module.ts` | `CacheModule` — Nest module binding `CACHE_PORT → RedisCacheAdapter` and registering the underlying `@nestjs/cache-manager` async config. |
| `cache-keys.ts` | `CACHE_KEYS` registry + backwards-compat `CacheHelper`. AUDIT-2026-05-08 markers preserved verbatim. |
| `decorators/cacheable.decorator.ts` | `@Cacheable({ key, ttlMs })` method decorator wrapping calls in `port.wrap(...)`. |
| `decorators/index.ts` | Barrel for `decorators/`. |
| `index.ts` | Barrel. |
| `spec/redis-cache.adapter.spec.ts` | Port-adapter contract test (get/set/del/wrap with a `Map`-backed stub `Cache`). |

### `libs/observability/`

| File | Role |
|------|------|
| `correlation.constants.ts` | `CORRELATION_ID_HEADER = 'x-correlation-id'`. |
| `correlation.types.ts` | Re-export of `ICorrelationPayload` from `libs/contracts/microservices` (canonical home; see §2). |
| `correlation-id.decorator.ts` | `@CorrelationId()` Nest param decorator — relocated verbatim. |
| `http-context.middleware.ts` | `CorrelationMiddleware` — relocated verbatim. |
| `logger.module.ts` | `LoggerModuleConfig` — relocated from `libs/config/`; `logMethod` hook gained a no-op stub for task-10 trace-ID enrichment. |
| `tracer.ts` | OTel bootstrap shell — empty body in task-04, filled by task-10. Imported as a side-effect from `main.ts`s. |
| `trace-context.interceptor.ts` | `TraceContextInterceptor` passthrough stub for task-10. |
| `metrics.module.ts` | `MetricsModule` empty placeholder for task-10. |
| `index.ts` | Barrel (excludes `tracer.ts` — that one is deep-imported as a side-effect). |
| `spec/http-context.middleware.spec.ts` | Behaviour test: middleware preserves inbound IDs and generates UUIDs otherwise. |

### `libs/ddd/`

| File | Role |
|------|------|
| `entity.base.ts` | `Entity<TId>` — equality by id within the same subtype. |
| `aggregate-root.base.ts` | `AggregateRoot<TId>` extends `Entity` with `addDomainEvent()` / `pullDomainEvents()`. |
| `value-object.base.ts` | `ValueObject<TProps>` — frozen props, structural equality. |
| `domain-event.base.ts` | `DomainEvent<TAggregateId>` — id (uuid), occurredAt, aggregateId. |
| `repository.port.ts` | `IRepositoryPort<TAggregate, TId>` — findById/save/delete. |
| `index.ts` | Barrel. |
| `spec/aggregate-root.base.spec.ts` | Pull-semantics + equality test. |

### Files modified outside the new libs

| File | Edit |
|------|------|
| `tsconfig.json` | Added 4 path aliases (`cache`, `ddd`, `messaging`, `observability`) plus a deep alias for `observability/tracer` (side-effect import). |
| `jest.unit.config.js` | Mirrored 5 alias entries. |
| `jest.e2e.config.js` | Mirrored 5 alias entries. |
| `libs/contracts/microservices/microservice-message-pattern.enum.ts` | Renamed enum **values** to dotted format (identifier names unchanged). See §3. |
| `libs/contracts/microservices/correlation.types.ts` | **New** — `ICorrelationPayload` canonical home (was previously in `libs/common/correlation/`). |
| `libs/contracts/microservices/index.ts` | Added `correlation.types` to the barrel. |
| `libs/contracts/{retail,inventory}/.../*.ts` (4 files) | Updated `ICorrelationPayload` import from `@retail-inventory-system/common` → relative `'../../microservices'` / `'../../../microservices'` (no longer cross-lib). |
| `libs/common/cache/cache.helper.ts` | Replaced body with shim re-export from `@retail-inventory-system/cache`. |
| `libs/common/correlation/{constants,decorator,middleware,types}.ts` | Each file's body replaced with shim re-export from `@retail-inventory-system/observability`. |
| `libs/common/config/microservice-client-configuration.ts` | Replaced body with shim re-export from `@retail-inventory-system/messaging`. |
| `libs/common/modules/microservice-client-{retail,inventory}.module.ts` | Each replaced with shim re-export from `@retail-inventory-system/messaging`. |
| `libs/common/index.ts` | Updated comment header on the deferred-shim block to reflect that the moves landed. |
| `libs/config/cache-module.config.ts` | Replaced body with shim re-export from `@retail-inventory-system/cache`. |
| `libs/config/logger-module.config.ts` | Replaced body with shim re-export from `@retail-inventory-system/observability`. |

## 2. Import-site rewrites under `apps/` (old → new)

The 11 modified files under `apps/`:

| File | Old import | New import |
|------|-----------|-----------|
| `apps/api-gateway/src/main.ts` | `LoggerModuleConfig` from `@retail-inventory-system/config` | `@retail-inventory-system/observability` |
| `apps/api-gateway/src/app/app.module.ts` | `CorrelationMiddleware` from `@retail-inventory-system/common`; `LoggerModuleConfig` from `…/config` | both from `@retail-inventory-system/observability` |
| `apps/api-gateway/src/app/api/order/order.module.ts` | `MicroserviceClientRetailModule` from `…/common` | `…/messaging` |
| `apps/api-gateway/src/app/api/order/order.controller.ts` | `CorrelationId` from `…/common` | `…/observability` |
| `apps/api-gateway/src/app/api/product/product.module.ts` | `MicroserviceClientInventoryModule` from `…/common` | `…/messaging` |
| `apps/api-gateway/src/app/api/product/product.controller.ts` | `CorrelationId` from `…/common` | `…/observability` |
| `apps/inventory-microservice/src/main.ts` | `LoggerModuleConfig` from `…/config` | `…/observability` |
| `apps/inventory-microservice/src/app/app.module.ts` | `cacheModuleConfig` and `LoggerModuleConfig` from `…/config` | `cacheModuleConfig` from `…/cache`; `LoggerModuleConfig` from `…/observability` |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts` | `CacheHelper` from `…/common` | `…/cache` |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/interfaces/product-stock-common-add.interface.ts` | `ICorrelationPayload` from `…/common` | `…/observability` |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/interfaces/product-stock-common-cache.interface.ts` | `ICorrelationPayload` from `…/common` | `…/observability` |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/interfaces/product-stock-common-get.interface.ts` | `ICorrelationPayload` from `…/common` | `…/observability` |
| `apps/notification-microservice/src/main.ts` | `LoggerModuleConfig` from `…/config` | `…/observability` |
| `apps/notification-microservice/src/app/app.module.ts` | `LoggerModuleConfig` from `…/config` | `…/observability` |
| `apps/retail-microservice/src/main.ts` | `LoggerModuleConfig` from `…/config` | `…/observability` |
| `apps/retail-microservice/src/app/app.module.ts` | `LoggerModuleConfig` from `…/config` | `…/observability` |
| `apps/retail-microservice/src/app/api/order/order.module.ts` | `MicroserviceClientInventoryModule` from `…/common` | `…/messaging` |

The shims in `libs/common/{cache,correlation,modules}` and
`libs/config/{cache,logger}-module.config` cover any consumer that
the migration missed; they are scheduled for deletion in task-14.

## 3. Routing-key naming decision

**Decision: rename to dotted format (Plan A).**

| Identifier | Old value | New value |
|------------|-----------|-----------|
| `INVENTORY_PRODUCT_STOCK_GET` | `inventory_product_stock_get` | `inventory.product-stock.get` |
| `INVENTORY_ORDER_CONFIRM` | `inventory_order_confirm` | `inventory.order.confirm` |
| `RETAIL_ORDER_CREATE` | `retail_order_create` | `retail.order.create` |
| `RETAIL_ORDER_CONFIRM` | `retail_order_confirm` | `retail.order.confirm` |
| `RETAIL_ORDER_GET` | `retail_order_get` | `retail.order.get` |

Rationale (recorded in detail in ADR-008):

1. The repo deploys all four apps together; there is no transitional
   window where gateway and microservices run different formats.
2. The integration-test infrastructure is reset each run
   (`yarn test:infra:reload`), so no in-flight messages survive
   the cutover.
3. AMQP routing-key conventions are dot-separated; the rename keeps
   the door open to topic-exchange routing
   (`inventory.*.get`, `retail.order.#`) without a second wire-format
   change later.
4. Identifier names on `MicroserviceMessagePatternEnum` are
   unchanged, so call sites continue to compile — only the wire
   format flipped. `ROUTING_KEYS` exposes the same strings as a
   more idiomatic constants object.

The `ICorrelationPayload` move is a notable structural decision:
the type is a **wire-format payload contract** (it shapes every
inbound RPC body), not an observability concern, so its canonical
home is `libs/contracts/microservices/correlation.types.ts`. The
`@retail-inventory-system/observability` barrel re-exports it for
app-side consumers that otherwise have no reason to import from
`@retail-inventory-system/contracts`. This avoids a cycle:
`libs/observability` already imports `AppNameEnum` from contracts;
having contracts import the type back from observability would have
been circular.

## 4. Observed behavioural drift

- **No e2e snapshot drift expected from the routing-key rename.**
  `MicroserviceMessagePatternEnum` identifier names are unchanged,
  so every gateway-side `client.send(MicroserviceMessagePatternEnum.X, …)`
  call and every microservice-side
  `@MessagePattern(MicroserviceMessagePatternEnum.X)` call updates
  in lockstep. The new wire format propagates to both ends in the
  same build. The e2e test suite was not run in this task (gate
  list per the task wording covers only `yarn install`, `yarn build`,
  `yarn lint`, `yarn test:unit`); task-05 should run the e2e suite
  before relying on the rename.
- **Cache key shape unchanged.** `CACHE_KEYS.productStock` produces
  byte-identical output to the previous `CacheHelper.keys.productStock`
  (the `CacheHelper` shim now delegates into `CACHE_KEYS`). The
  `product-stock-common-cache.service.ts` consumer is the only call
  site under `apps/`; it switched its import path only.
- **Pino `logMethod` gained a stub comment.** A documentation-only
  change; no behavior change. Trace-ID enrichment lands in task-10.

## 5. ADR numbers assigned

| ADR | Topic | File |
|-----|-------|------|
| 006 | Cache-aside via `libs/cache` port and adapter | `docs/adr/006-cache-aside-via-libs-cache.md` |
| 007 | Pino structured logs + OpenTelemetry trace correlation | `docs/adr/007-pino-and-opentelemetry.md` |
| 008 | RabbitMQ wiring via `libs/messaging` and dotted routing keys | `docs/adr/008-rabbitmq-via-libs-messaging.md` |

`CLAUDE.md` was bumped to record `009` as the next free slot.

## 6. Verification

### Exit gate (post-task-04)

```
$ yarn install
➤ YN0000: · Done in 2s 119ms

$ yarn build
webpack 5.106.0 compiled successfully in 8675 ms   # api-gateway
webpack 5.106.0 compiled successfully in 9410 ms   # inventory-microservice
webpack 5.106.0 compiled successfully in 9020 ms   # retail-microservice
webpack 5.106.0 compiled successfully in 9056 ms   # notification-microservice

$ yarn lint
# (no output; exit 0)

$ yarn test:unit
PASS libs/cache/spec/redis-cache.adapter.spec.ts
PASS libs/messaging/spec/routing-keys.constants.spec.ts
PASS libs/observability/spec/http-context.middleware.spec.ts
PASS libs/ddd/spec/aggregate-root.base.spec.ts
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-add.service.spec.ts
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-cache.service.spec.ts
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-get.service.spec.ts
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/spec/product-stock-common.service.spec.ts
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-get.service.spec.ts
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-order-confirm.service.spec.ts
PASS apps/retail-microservice/src/app/api/order/domain/spec/order-confirm.domain.spec.ts

Test Suites: 11 passed, 11 total
Tests:       70 passed, 70 total
```

All four exit gates pass. Tests increased from 59 → 70 (4 new
suites, 11 new tests across the four integration libs).

### Working-tree shape

The four new `libs/{messaging,cache,observability,ddd}/` directories
appear as untracked. Modifications under `libs/{common,config,contracts}/`
are all shim conversions plus the `ICorrelationPayload`-canonical-home
move under `libs/contracts/microservices/`. Modifications under
`apps/` are import-path rewrites only — no logic changes.

### Test infra

`yarn test:e2e` was **not** run by this task. The wire-format
routing-key rename (snake_case → dotted) is a breaking change for
the wire format; task-05 should run the e2e suite first thing.
Local `yarn test:unit` covers the symbolic alignment between
`ROUTING_KEYS` and `MicroserviceMessagePatternEnum`.

## 7. Suggested adjustments to task-05 (gateway alignment)

Concrete recommendations informed by what this task left in place:

1. **Run `yarn test:e2e` as the first action.** Task-04 changed the
   RabbitMQ wire format (snake_case → dotted) and did not run the
   e2e gate. Task-05 should validate the rename across the live
   broker before doing any new structural work. If the rename is
   wrong (e.g., a microservice's `@MessagePattern` was missed), it
   shows up here.

2. **The `MicroserviceClient*Module` imports are already on the new
   alias.** Task-05 doesn't need to touch them. The hexagonal
   re-org of `apps/api-gateway/src/app/api/{order,product}/` can
   focus on `domain/`, `application/`, `infrastructure/` split
   without revisiting messaging wiring.

3. **`CorrelationId` and `LoggerModuleConfig` are now on
   `@retail-inventory-system/observability`.** When task-05 carves
   the gateway into `domain/application/infrastructure/`,
   `CorrelationId` belongs in the controller layer (infrastructure)
   alongside the HTTP entry point, not in `domain/`.

4. **`ROUTING_KEYS` is the new idiomatic constant.** New publisher
   call sites in task-05 should use `ROUTING_KEYS.RETAIL_ORDER_CREATE`
   instead of `MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE`.
   The enum keeps working for existing call sites; do not flip them
   in task-05 — that's a separate cleanup pass at task-14 alongside
   shim removal.

5. **The publisher-port introduction stays in task-08/task-09.**
   ADR-008 explicitly defers it. Task-05 should not introduce an
   `IMessagePublisher` port today — wait for the consuming-service
   re-org.

6. **No `nest-cli.json` `projects` entries were added.** Per the
   task-03 carryover, this task kept the existing four-lib
   convention (`contracts`, `database`, `common`, `config`) of not
   registering libs as Nest projects. The three new libs follow the
   same pattern; webpack resolves them via tsconfig paths. If
   task-05 (or later) decides to standardize all eight libs as
   proper Nest libraries, do all eight at once.

7. **Tests for the new libs are minimal.** Each new lib has one
   unit test that covers its primary contract:
   - `messaging`: routing-key alignment between constants and enum.
   - `cache`: port-adapter contract for get/set/del/wrap.
   - `observability`: middleware behaviour for the two branches.
   - `ddd`: aggregate-root pull semantics and equality.

   Task-05 should not pad them. Per-feature spec coverage belongs
   with the consumer in tasks 08/09.

8. **The `ICorrelationPayload` move is invisible to apps.** The
   re-export from `libs/observability` keeps the call site working;
   the canonical home shifted to `libs/contracts`. Task-05 can
   safely import either path; prefer `@retail-inventory-system/observability`
   for app-layer consumers and `@retail-inventory-system/contracts`
   for cross-service interface definitions.
