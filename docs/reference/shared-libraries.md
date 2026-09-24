# Shared libraries

The libraries under `libs/` other than `contracts` (which has its own file,
[`wire-contracts.md`](wire-contracts.md)): `auth`, `cache`, `common`, `config`, `database`, `ddd`,
`messaging`, `observability`. What each library exports is the table in
[`README.md` §3](../../README.md#shared-libraries); this file holds only what the exports do not say
out loud. The rationale lives in the ADRs: [ADR-017](../adr/017-architecture-lint-via-eslint-boundaries.md)
(why `ddd` and `common` are framework-free), [ADR-021](../adr/021-cache-single-flight-and-ttl-jitter.md) /
[ADR-022](../adr/022-cache-keys-tenant-and-schema-version.md) /
[ADR-046](../adr/046-libs-layout-and-dead-export-removal.md) (cache keys),
[ADR-035](../adr/035-event-store-firehose-topic-exchange.md) (the `ris.events` mirror),
[ADR-043](../adr/043-lifting-forced-duplicates-into-shared-libs.md) /
[ADR-045](../adr/045-one-occ-retry-protocol.md) /
[ADR-056](../adr/056-lifting-the-post-commit-retry-helper.md) (what was lifted into a lib and why),
[ADR-054](../adr/054-the-entity-manager-downcast-is-an-idiom.md) /
[ADR-063](../adr/063-unit-of-work-for-stock-orders-returns.md) (the transaction seams) and
[ADR-060](../adr/060-what-drains-a-domain-event.md) (who drains a domain event).

## `auth`

- **A claim guard admits on any one listed value, and the handler's list replaces the class's.**
  `RolesGuard` and `PermissionsGuard` share one body: the route's metadata is read with
  `getAllAndOverride([handler, class])`; no metadata, or an empty list, lets the request through; otherwise
  the subject must carry **at least one** of the listed values. A handler that declares its own list is
  not widened by the class-level one — it replaces it. A missing `request.user`, or a claim that is not an
  array, is refused with `403` (`ForbiddenException('Insufficient permissions')`), never a `500`
  (`libs/auth/guards/claim-guard.util.ts`, `enforceRequiredClaim`; pinned against the real `Reflector`
  in `libs/auth/spec/roles.guard.spec.ts`).
- **`@Roles(...)` is applied to no route.** `RolesGuard` still runs globally and lets every route through
  for want of metadata; `libs/auth/spec/roles.guard.spec.ts` is the only place the decorator is invoked,
  and it is what proves the decorator and the guard agree on `ROLES_KEY`.
- **The library verifies the token; the host decides whether the subject still exists.** `JwtStrategy`
  reads the bearer header and lets `passport-jwt` check the signature against `JWT_ACCESS_SECRET` and
  the expiry, then hands the payload to whatever the host bound to `AUTH_USER_VALIDATOR`
  (`libs/auth/jwt.strategy.ts`, `JwtStrategy.validate`). The library binds nothing to that token: the host
  passes the binding in through `AuthModule.forRootAsync({ providers })`, and the module is `global`
  (`libs/auth/auth.module.ts`, `AuthModule.forRootAsync`). The gateway binds `ValidateJwtSubjectUseCase`,
  which answers `401` for an account that is no longer active
  (`apps/api-gateway/src/modules/auth/auth.module.ts`).

## `cache`

### `CACHE_KEYS` — live, reserved and retired builders

`libs/cache/cache-keys.ts` is the registry of every key shape; the convention itself (segments, tenant,
sorted location facet, `__all__`) is [`README.md` §12](../../README.md#key-convention). A builder is in one
of three states, and only the first has a caller:

| State        | Builders                                                                                                                                                                                      | Meaning                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live**     | `inventoryStockPrefix`, `inventoryStock` (`v3`); `notificationsConsent` (`v1`)                                                                                                                | the two cached read paths — inventory's `StockCache` and the notification consent cache                                                                 |
| **Reserved** | `retailOrderPrefix` / `retailOrder`, `catalogProduct*`, `catalogPrice*`, `catalogCategoryTree`, `catalogCategoryChildren*`, `notificationsTemplate*`, `notificationsConsentPrefix` (all `v1`) | no caller; a future cached read path adopts the shape as it stands. Their services do not import `CacheModule` — only inventory and notification do     |
| **Retired**  | `inventoryStockLegacyPrefixV2`, `inventoryStockLegacyPrefixV1`, `inventoryStockLegacyPrefix`, `productStockPrefix`                                                                            | the shapes the stock key had before `v3`. Nothing reads, writes or sweeps them; they are kept as the record of what each version bump changed (ADR-046) |

- **A retired shape has only a prefix builder, and that is what makes it unreachable.** Without a
  full-key builder no read path can build a retired key, so an entry under one could never be served and
  simply expires on its TTL. `StockCache` invalidates the live `v3` prefix only — one
  `delByPrefix` per affected variant
  (`apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`,
  `StockCache.invalidatePrefixes`). The retired shapes never carried a tenant segment and take no
  `opts`.
- **Two reserved keys are shaped differently from their siblings, on purpose.** `catalogCategoryTree`
  ends at the version segment — the tree is one value, so there is no `<id>` axis — while
  `catalogCategoryChildren` does not. `notificationsTemplatePrefix` stops before the locale, so one
  `delByPrefix` clears every locale of an `(eventType, channel)` pair.

### `RedisCacheAdapter`

- **A cached `null` reads as a miss.** `get` returns `undefined` for both `null` and `undefined`, so a
  loader that returns `null` is re-run on every read (`libs/cache/redis-cache.adapter.ts`,
  `RedisCacheAdapter.get`).
- **`wrap` is read-through but not single-flighted.** Concurrent misses on one key each run the loader;
  a caller that needs the stampede guard calls `singleFlight` itself, as `StockCache` does. The
  single-flight map is per process (ADR-021).
- **`delByPrefix` can return `0` without having deleted anything.** It inspects only the first configured
  store: a store that is not `KeyvRedis`, or a Redis client without `scanIterator` / `unlink` (a Cluster or
  Sentinel client), returns `0` and deletes nothing, with no error. Otherwise it SCANs
  `<namespace><separator><prefix>*` in batches of 100, de-duplicates the keys across SCAN cycles and
  issues a single `UNLINK` (`RedisCacheAdapter.delByPrefix`; every branch is pinned in
  `libs/cache/spec/redis-cache.adapter.spec.ts`).
- **The Redis connection is closed only by `app.close()`.** `onApplicationShutdown` disconnects the
  client, but no service calls `enableShutdownHooks()`, and the tracer's own `SIGTERM` / `SIGINT`
  handler exits the process (see [`observability`](#observability)). In practice the hook runs in e2e
  teardown.
- **`CacheModule` is `@Global()`** and registers the Nest cache module with `isGlobal: true`; import it
  once, at the app root (`libs/cache/cache.module.ts`).

### `@Cacheable()`

`@Cacheable()` has no caller. Its key template resolves **by position, not by name**: the n-th `{…}`
placeholder is replaced by the n-th argument of the decorated method, whatever the name inside the braces
(`libs/cache/decorators/cacheable.decorator.ts`, `renderKey`). It also puts a key string literal in the
calling app, which the cache-key convention forbids.

## `common`

### `runWithOccRetry` and `OCC_RETRY_ATTEMPTS`

The protocol — what retries, the log levels and messages, `maxAttempts: 1` for an `If-Match` write, and
why `onExhausted` returns `never` — is [ADR-045](../adr/045-one-occ-retry-protocol.md) §1, pinned by
`libs/common/concurrency/spec/occ-retry.spec.ts`. Beyond it:

- **The token is shared; the budget is per module.** `OCC_RETRY_ATTEMPTS` is one symbol, but each of the
  four modules that uses it (`stock`, `cart`, `orders`, `returns`) binds its own value provider in its
  `<m>.module.ts`. All four read the `OCC_RETRY_ATTEMPTS` environment variable today; nothing forces them
  to agree.
- The retry trace takes its fields from `retryContext(conflict)` and the exhaustion trace from
  `exhaustedContext(conflict)`; each is logged together with the attempt number and `maxAttempts`
  (`libs/common/concurrency/occ-retry.ts`, `runWithOccRetry`).

### `retryThenLogForReplay`

The one posture for a cross-service call made **after** the caller's own transaction has committed
([ADR-056](../adr/056-lifting-the-post-commit-retry-helper.md)).

- **It never throws.** Each failed attempt but the last is logged at `warn` as `<label> failed — retrying`,
  with the attempt number and the caller's `context`. The last failure is logged at `error` with the full
  `context` and the caller's `replayMessage` — the poison record an operator replays from — and the
  function returns normally, because the local write is already durable
  (`libs/common/resilience/retry-then-log-for-replay.ts`, `retryThenLogForReplay`).
- **Retries are immediate; `maxAttempts` bounds latency, not safety.** There is no backoff, and each call
  site awaits the helper before it replies to its own caller, so a larger budget only holds that request
  open longer against a broker that is down. A timed-out attempt is not cancelled, so the next attempt can
  race it ([ADR-057](../adr/057-cancel-allocation-needs-an-operation-identity.md)).
- **What makes a repeated delivery safe is the callee's unique key, and it differs per call.**

  | Call site                                                                                                  | `label`               | `maxAttempts` | What makes a second delivery a no-op                                                          |
  | ---------------------------------------------------------------------------------------------------------- | --------------------- | ------------- | --------------------------------------------------------------------------------------------- |
  | `ShipFulfillmentUseCase` (`orders`) → `inventory.stock.commit-sale`                                        | `Commit Sale`         | 3             | `UC_STOCK_MOVEMENT_DEDUPE` over the `sale` rows, keyed on the fulfillment id                  |
  | `InspectAndDispositionUseCase` (`returns`) → `inventory.stock.restock-from-return`                         | `Restock-from-Return` | 3             | the same UNIQUE over the `return` rows, keyed on the return request id                        |
  | `releaseAllocationWithRetry` (`orders`, from Cancel Order and Cancel Line) → `inventory.allocation.cancel` | `Cancel-Allocation`   | 3             | the same UNIQUE over the `release` rows that carry the caller-minted `operationKey` (ADR-057) |

  The dedupe key is a stored generated column, `movement_dedupe_key`, which is non-NULL only for those
  three arms (`migrations/1784010000000-AddStockMovementOperationKey.ts`,
  `AddStockMovementOperationKey1784010000000.up`).

- A `maxAttempts` below `1` runs the operation zero times and returns silently. Every caller passes the
  constant `3`.

### `bodyFingerprint`

The canonical form behind the idempotency store's same-key / different-body check
([ADR-036](../adr/036-idempotency-key-store-and-enforced-occ.md)):

- Object keys are sorted at every depth (default `Array.prototype.sort` order); array order is kept, so a
  reordered list is a different body.
- A key whose value is `undefined` is dropped — it hashes the same as an absent key. `null` is kept and
  differs from both. An `undefined` array element becomes `null`.
- A top-level `undefined` (or anything `JSON.stringify` cannot serialize) hashes as the string `'null'`,
  so the function never throws.
- The digest is lowercase SHA-256 hex, 64 characters — the `CHAR(64)` `request_fingerprint` column.
- It hashes whatever it is given; choosing the logical body (without `correlationId`, the key itself or
  owner-injected ids) is the caller's job.

(`libs/common/idempotency/body-fingerprint.util.ts`, `bodyFingerprint`; each rule, and the digest of one
known input, is pinned in `libs/common/idempotency/spec/body-fingerprint.util.spec.ts`.)

### `clampPageWindow`

Turns an untrusted `(page, size)` pair into a safe window. Both values are **floored before** the
positivity check, so a page in `(0, 1)` becomes the default page rather than `0` — which a
`skip((page - 1) * size)` would turn into a negative offset. A missing, non-numeric or non-positive value
takes the default (`1` / `20`); `size` is then capped at `maxSize` (`100`)
(`libs/common/pagination/clamp-page-window.ts`, `clampPageWindow`). Which RPCs use it, and the one that
does not, is in [`wire-contracts.md`](wire-contracts.md#conventions-across-every-context).

## `config`

Every variable in the Joi schema is documented in [`README.md` §8](../../README.md#8-configuration).
The schema is shared by all six services, so a required key fails the boot of every one of them, including
the services that never read it (`libs/config/config-module.config.ts`, `configModuleConfig`).

## `database`

### Leave an entity list unannotated

A module's `<x>Entities` const (`cartEntities`, `orderEntities`, `stockEntities`, …) must be left for
TypeScript to infer. Annotating it with `TypeOrmModuleOptions['entities']` — the type of
`DatabaseModule.forRoot`'s parameter — breaks both of its other uses as soon as it is imported from
another file. That type is `MixedList<Function | string | EntitySchema> | undefined`: an array, an
object map, or nothing. So:

- the spread that merges two lists — `DatabaseModule.forRoot([...catalogEntities, ...pricingEntities])` in
  `apps/catalog-microservice/src/app/app.module.ts` — fails with `TS2488` (the type has no iterator);
- `DatabaseModule.forFeature(<x>Entities)` fails with `TS2345`, because `forFeature` takes
  `EntityClassOrSchema[]` and `string` is not assignable to it.

Inside the declaring file TypeScript narrows the annotated const back to an array, which is why the break
shows up only at the import site. An explicit `EntityClassOrSchema[]` annotation is not a way out either:
`@nestjs/typeorm` does not export that type from its root, so it would cost a deep import from
`@nestjs/typeorm/dist/`, as `DatabaseModule.forFeature` itself does
(`libs/database/database.module.ts`, `DatabaseModule.forRoot` / `DatabaseModule.forFeature`).

### Connections and transactions

- `forRoot(entities)` is `forRootWithUrl(entities, 'DATABASE_URL')`; both open a connection with the same
  options — `synchronize: false`, `timezone: 'Z'`, `SnakeNamingStrategy`, query logging from
  `DATABASE_LOGGING` (`DatabaseModule.forRootWithUrl`). Why the UTC pin matters is in
  [`README.md` §9](../../README.md#migrations).
- **`TypeormTransactionAdapter` works on the default connection only.** It injects the default
  `EntityManager` (`@InjectEntityManager()`), so it cannot open a transaction on the event store's
  `EVENTSTORE_DATABASE_URL` connection — and the event store binds no transaction port. It is bound to
  `TRANSACTION_PORT` by `stock` and `orders`; `returns` has moved to the Unit of Work
  (`libs/database/typeorm-transaction.adapter.ts`, `TypeormTransactionAdapter`; ADR-063). Both directions
  of the `EntityManager` downcast live in that file (ADR-054).
- **`TypeormUnitOfWorkRunner` builds a fresh repository bag for every `run()`,** from the transaction's own
  `EntityManager`, through the module-supplied `build` callback; it never hands out the module's
  default-connection repositories (`libs/database/typeorm-unit-of-work.adapter.ts`,
  `TypeormUnitOfWorkRunner.run`). `returns` is its only user so far
  (`apps/retail-microservice/src/modules/returns/infrastructure/persistence/returns-unit-of-work.adapter.ts`).

## `ddd`

- **Two unsaved entities of the same class are equal.** `Entity.equals` compares the constructor and then
  the ids with `===`, and a not-yet-persisted child entity (`OrderLine`, `CartLine`, `ReturnLine`, …) has
  the id `null` (`libs/ddd/entity.base.ts`, `Entity.equals`).
- **`ValueObject` equality is `JSON.stringify` of the props.** Props are copied and shallow-frozen at
  construction. Because equality compares serializations, the order in which props are passed matters, a
  `Map` or `Set` prop serializes to `{}` whatever it holds, an `undefined` prop is invisible and nested
  objects are neither frozen nor compared by identity (`libs/ddd/value-object.base.ts`,
  `ValueObject.equals`). Subclasses today: `Notification`, `OptionValues`, `Dimensions`.
- **A `DomainEvent` takes its `id` and `occurredAt` when it is constructed** — a `randomUUID()` and the
  in-process clock — not when it is published (`libs/ddd/domain-event.base.ts`, `DomainEvent`).
- **Who drains `pullDomainEvents()`, and from which instance,** is [ADR-060](../adr/060-what-drains-a-domain-event.md):
  the use case, from the aggregate it mutated, never from what `save` returned. Publication after the
  drain is best-effort at-most-once
  ([ADR-020](../adr/020-rabbitmq-as-inter-service-bus.md)).
- **`asReconstituted` is a shallow, prototype-preserving clone with an empty event buffer.** It leaves the
  argument's own buffer untouched, so the correct pattern — drain the local you mutated — still works
  against a double that uses it (`libs/ddd/testing/as-reconstituted.ts`, `asReconstituted`).
- **The two `testing` barrels are deep-import only.** `@retail-inventory-system/ddd/testing` and
  `@retail-inventory-system/observability/testing` have their own `tsconfig.json` path aliases and are not
  re-exported from their library's `index.ts`. That omission is the only thing keeping production code
  out; no lint rule forbids the deep path.
- `ITransactionPort` / `ITransactionScope` and `IUnitOfWorkRunner` live in `ddd` rather than `database`
  because `application/ports` may import only `lib-ddd` and `lib-contracts`
  ([ADR-043](../adr/043-lifting-forced-duplicates-into-shared-libs.md),
  [ADR-063](../adr/063-unit-of-work-for-stock-orders-returns.md)).

## `messaging`

- **On the `ris.events` client, the pattern becomes the AMQP routing key.** Every other
  `MicroserviceClient*Module` sends to its configured queue on the default exchange and carries the
  pattern inside the message body. `MicroserviceClientRisEventsModule` sets `exchange: 'ris.events'`,
  `exchangeType: 'topic'` and `wildcards: true`, and with `wildcards` Nest's RMQ client publishes to the
  exchange with the pattern as the routing key. On connect the client asserts the durable topic exchange
  and **no queue**, so its `queueOptions` have no effect
  (`libs/messaging/clients/microservice-client-ris-events.module.ts`).
- **`emitBestEffort` bounds the publish and swallows every failure.** It awaits the `emit` under an rxjs
  `timeout` of `BEST_EFFORT_EMIT_TIMEOUT_MS` (5 s). A rejection or a timeout is logged at `warn` with the
  routing key, the `correlationId` and the **whole payload** — so a dropped event can be recovered from the
  log — and is never rethrown (`libs/messaging/ris-events-mirror.publisher.ts`, `emitBestEffort`). It
  backs `RisEventsMirrorPublisher.mirror`, and also the gateway's primary emit of the customer consent and
  erasure events
  (`apps/api-gateway/src/modules/auth/infrastructure/messaging/customer-events.rabbitmq.publisher.ts`).
  `libs/messaging/spec/ris-events-mirror.publisher.spec.ts` pins the swallow and, with an emit that never
  settles, the timeout.
- **`sendPreservingRpcError` exists for a service that relays another service's RPC.** It rethrows any
  rejection as `RpcException(err)`. Nest's RPC exception handling passes an `RpcException`'s error object
  through as-is and replaces anything else with a bare `Internal server error`, so without the wrap the
  upstream `code` and `details` (an inventory `INVENTORY_OUT_OF_STOCK` with `details.available`) would be
  lost at the relaying hop (`libs/messaging/rpc-passthrough.ts`, `sendPreservingRpcError`). Its callers
  are the four retail adapters that relay inventory RPCs
  (`cart-inventory`, `order-inventory`, `order-commit-sale`, `inventory-restock`).
- **`ROUTING_KEYS.MARKETING_EMAIL_PROMO` is not a routing key.** Nothing publishes or binds
  `marketing.email.promo`: it is the `eventType` the gateway's marketing send defaults to and the key the
  seeded marketing template is stored under (`scripts/seeds/notification-template.sql`). It is absent from
  `TRANSACTIONAL_EVENT_TYPES`, so the consent gate treats it as marketing
  ([ADR-037](../adr/037-consent-record-and-tombstone-erasure.md)).
- **A new routing key must follow three rules, which `libs/messaging/spec/routing-keys.constants.spec.ts`
  enforces for every entry:** the constant's name is its value upper-cased with `.` and `-` turned into
  `_`; the value is dotted lower-case; and no two names share a value.

## `observability`

### `LoggerModuleConfig`

- The level is `LOG_LEVEL` if set, else `info` in production and `debug` elsewhere — **except** while the
  e2e capture is installed, when it is forced to `debug` whatever `LOG_LEVEL` says, because e2e suites
  assert on `info` lines that CI's `LOG_LEVEL=warn` would drop
  (`libs/observability/logger.module.ts`, `LoggerModuleConfig`).
- Outside production, `info` lines from Nest's bootstrap contexts (`InstanceLoader`, `NestFactory`,
  `NestApplication`, `NestMicroservice`, `RouterExplorer`, `RoutesResolver`) are dropped.
- `req.headers.authorization`, `req.headers.cookie` and `res.headers["set-cookie"]` are removed from every
  record, not masked. Every message is prefixed `[<app>] `.
- Output goes three ways: JSON to stdout in production, `pino-pretty` elsewhere, and raw JSON into the
  capture stream when one is installed — passed to `pino-http` as the second element of the
  `[options, destination]` tuple.

### The e2e log capture

`installMemoryPinoLogger()` (`libs/observability/testing/pino-memory-stream.ts`) puts a memory stream on
a `globalThis` slot that `LoggerModuleConfig` reads **in its constructor**. Every app constructs
`LoggerModuleConfig` inside its `AppModule`'s `@Module` decorator, so the capture must be installed before
`AppModule` is loaded — which is why `test/jest.setup.ts` installs it at setup-file time. The slot's name,
`__RIS_E2E_PINO_DESTINATION__`, is written as a literal in both files and the two must stay equal. Lines
that are not JSON are dropped from `capturedLogs`.

### `tracer.ts`

- **The tracer reads `process.env` directly, before the Joi schema runs.** So `OTEL_SDK_DISABLED` disables
  the SDK only when it is exactly the string `true` (`libs/observability/tracer.ts`). `OTEL_DIAG_LOG_LEVEL=debug`
  — a variable that is in neither the schema nor `.env.example` — turns on OpenTelemetry's own diagnostic
  logger.
- The resource carries `service.name` from `OTEL_SERVICE_NAME` (`unknown-service` if unset) and
  `deployment.environment.name` from `NODE_ENV` (`development` if unset). The exporter takes its URL from
  the standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`.
- **With the SDK enabled, `SIGTERM` and `SIGINT` end the process.** The tracer flushes spans, then calls
  `process.exit(0)`, so a service stops without Nest's shutdown hooks — none of the `main.ts` files
  enables them anyway. With the SDK disabled no handler is registered.

### `CorrelationMiddleware`

It writes the chosen id back into the **request** headers as well as the response, so `@CorrelationId()`
— which reads the request header — returns the minted id on a request that arrived without one
(`libs/observability/correlation/http-context.middleware.ts`, `CorrelationMiddleware.use`;
`libs/observability/correlation/correlation-id.decorator.ts`, `CorrelationId`).
