# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working with code in this repository.

> **Charter — read this before editing this file.**
>
> This file is a **map**: *what exists and where*, plus the constraints and landmines an
> agent cannot discover cheaply. It is **not** a place for operation mechanics, business
> rules, rationale, or history. Those drift — and a stale copy here is **worse than no
> copy**, because an agent trusts this file over the code.
>
> Authoritative detail lives in four places. Cite them; do not summarise them:
> the **code**; each module's **`*RpcExceptionFilter`** (the error-code → HTTP tables);
> the **ADRs** under [`docs/adr/`](docs/adr/); and **[`README.md`](README.md)** (the
> human-facing description of how the system behaves).

## Commands

```bash
# Development — six services
yarn start:dev                          # all six concurrently (scripts/bash/start-dev.sh)
yarn start:dev:<service>                # api-gateway | catalog-microservice | inventory-microservice
                                        #   | retail-microservice | notification-microservice
                                        #   | event-store-microservice
yarn start:prod:<service>               # run a built service from dist/

# Build
yarn build                              # nest build --all
yarn build:<service>

# Code quality (CI runs lint → build)
yarn lint                               # ESLint incl. boundaries/*, --max-warnings 0
yarn lint:fix
yarn format:check
yarn format

# Migrations — retail_db (operational)
yarn migration:run | migration:revert | migration:show
yarn migration:create <Name>            # scaffolds into migrations/

# Migrations — ris_eventstore (isolated event-store schema, ADR-034)
yarn migration:run:eventstore | migration:revert:eventstore | migration:show:eventstore
yarn migration:create:eventstore <Name> # scaffolds into migrations/eventstore/

# Testing
yarn test:unit                                        # full Jest unit suite
npx jest --config jest.unit.config.js -i <pattern>    # ONE spec — see Landmines
yarn test:e2e                                         # test:infra:reload + full e2e
yarn test:e2e:run                                     # e2e only (infra must be up)
yarn test:infra:up | test:infra:down                  # MySQL + Redis + RabbitMQ (down drops volumes)
yarn test:infra:reload                                # down → up → BOTH migration runs → seed
yarn test:seed                                        # scripts/test-db-seed.ts
```

## Landmines

Non-obvious facts, each worth a debugging cycle. The rest of this file is a map; this
section is the reason to read it.

**Boot / observability**

- `main.ts`'s **first import MUST be** `@retail-inventory-system/observability/tracer`.
  OTel auto-instrumentation patches at module load; anything `require()`d before it is
  invisible to tracing.
- Never call `PinoLogger.assign()` inside an `@EventPattern` handler — those are not
  request-scoped and it throws. Log `correlationId` inline (ADR-011 §7).

**RabbitMQ**

- **Never rethrow from an `@EventPattern`** — the broker blind-redelivers in a hot loop.
- The firehose binds a **lone `#`**, not `#.#`. RabbitMQ routes both, but Nest's
  `matchRmqPattern` nacks every multi-word routing key under `#.#`.
- **Producer targets the consumer's queue** (ADR-008/020): an event is emitted onto the
  queue of whoever consumes it, not the producer's own.
- `RisEventsMirrorPublisher.mirror` is non-throwing best-effort and is ordered **after**
  the primary `emit`, so a `ris.events` failure can never shadow the real publish.
- A single Nest app binds every `@EventPattern` to every connected transport — two queues
  with disjoint pattern sets in one app is not supported.

**Persistence**

- MySQL treats `NULL`s as distinct inside a UNIQUE. `IngestDomainEventUseCase` coalesces
  an empty `correlationId` to `''`, otherwise the `domain_event` dedupe UNIQUE never bites.
- Append-only tables (`stock_movement`, `domain_event`, `audit_log_entry`,
  `idempotency_key`) implement their repository port **directly**, never through
  `BaseTypeormRepository` — its `save`/`softDelete` would break the invariant.
- `condition` is a MySQL reserved word — backticked in the `return_line` migration.
- `reservation.cart_id` is overridden to `utf8mb4_unicode_ci` to match the retail `cart`
  column's collation.
- `DatabaseModule.forRoot` pins `mysql2` to UTC (`timezone: 'Z'`); without it the driver
  falls back to the Node host's local zone and the pricing publish probe's
  `price.valid_from` vs `UTC_TIMESTAMP()` comparison skews.

**Config / DI**

- **A use case never reads `process.env`.** Config arrives through a value-provider token:
  `OCC_RETRY_ATTEMPTS`, `RESERVATION_TTL_MINUTES`, `RETURN_WINDOW_DAYS`,
  `IDEMPOTENCY_KEY_TTL_HOURS`, `MAX_DELIVERY_ATTEMPTS`, `OPS_NOTIFICATIONS_EMAIL`,
  `CONSENT_CACHE_TTL_SECONDS`, `CATALOG_DEFAULT_CURRENCY`. The sole exception is
  `NOTIFIER_TEST_FLAKY` (test-only, read off `process.env` inside a `useFactory`).
- A new `PermissionCodeEnum` member auto-seeds to the `admin` role **only if** it is also
  added to `PERMISSION_SEEDS` in `scripts/test-db-seed.ts`.
- `EVENTSTORE_DATABASE_URL` is a **required** Joi key in the shared schema, so it must be
  set for every service — but only the event store opens it.

**Repo**

- `.env.local` **is git-tracked** (CI reads it). `CLAUDE.md` is **untracked**, excluded via
  `.git/info/exclude` — edits to it never show up in `git status`.
- Bare `npx jest` fails with a Babel TypeScript parse error (not a code bug). Always pass
  `--config jest.unit.config.js`.
- `yarn lint` is the **source of truth for where a file belongs**. Never weaken a
  `boundaries/*` rule to make code pass.
- `test:infra:reload` runs **both** migration pipelines; `yarn migration:run` alone leaves
  `ris_eventstore` empty.

## Cross-cutting conventions

Four conventions bind code you may be touching. **Read the linked source before changing any
of them** — they are not restated here, on purpose.

| Convention | Where it is specified |
| --- | --- |
| Request-level idempotency on the four money-/stock-moving writes (`Idempotency-Key` required, replay / `422` / `400`) | ADR-036; [`README.md` §5](README.md#5-cross-cutting-guarantees) |
| Version-checked OCC on every aggregate write, bounded by `OCC_RETRY_ATTEMPTS`, exhaustion → `409 VERSION_MISMATCH` | ADR-036; the `*-write.ts` helper in each module's `application/use-cases/` |
| No-oversell, reservation TTL, "audit not balance" | ADR-027 / ADR-030; `stock-mutation.ts` |
| Privacy: tombstone-only erasure, **no PII in an event payload or an audit row**, default-transactional-on / default-marketing-off consent | ADR-037 |

## Architecture

NestJS monorepo: five microservices + an API gateway (six deployables), communicating over
RabbitMQ (request-response RPC + events).

**Request flow:** HTTP → API Gateway (auth + global guards) → RabbitMQ → Microservice → MySQL.

| Deployable | Transport | Owns |
| --- | --- | --- |
| `api-gateway` | HTTP `:3000`, prefix `/api` | thin RPC-fronting modules + `auth` (real domain state) and the `iam` / `customer-admin` admin shells |
| `catalog-microservice` | `catalog_queue` | `modules/catalog/` + the colocated `modules/pricing/` |
| `inventory-microservice` | `inventory_queue` | `modules/stock/` |
| `retail-microservice` | `retail_queue` | `modules/cart/`, `modules/orders/`, `modules/returns/` |
| `notification-microservice` | `notification_events` | `modules/notifications/` (RMQ-only, no HTTP) |
| `event-store-microservice` | `event_store_firehose_queue` | `audit-and-events` context; its **own** DB `ris_eventstore` (ADR-034) |

```
apps/
libs/
  auth/           # JWT + RBAC framework glue (AuthModule.forRootAsync, guards, decorators)
  cache/          # ICachePort + RedisCacheAdapter + @Cacheable + CACHE_KEYS registry
  common/         # framework-free: Result, DomainException, pagination, bodyFingerprint
  config/         # configModuleConfig (Joi env schema)
  contracts/      # cross-service message + DTO contracts (auth, microservices, retail,
                  #   inventory, catalog, notifications)
  database/       # BaseEntity, BaseTypeormRepository, SnakeNamingStrategy, DatabaseModule
  ddd/            # Entity, AggregateRoot, ValueObject, DomainEvent, IRepositoryPort
  messaging/      # MessagingModule, MicroserviceClient*Module, RabbitmqClientFactory,
                  #   RisEventsMirrorPublisher, ROUTING_KEYS, EXCHANGES
  observability/  # Pino LoggerModuleConfig + correlation + OTel tracer.ts + MetricsModule
migrations/       # TypeORM migrations + data-source config; migrations/eventstore/
```

**Queues:** `retail_queue`, `inventory_queue`, `notification_events`, `catalog_queue`,
`event_store_firehose_queue`.

**Exchange:** `EXCHANGES.RIS_EVENTS_TOPIC` (`ris.events`) is the **one live** member
(`RETAIL`/`INVENTORY`/`NOTIFICATION` stay reserved, default-exchange-only). Every producer
**dual-publishes** — the existing default-exchange `emit`, then a mirror onto `ris.events`
via `RisEventsMirrorPublisher` (ADR-035). `event_store_firehose_queue` binds `#` and its
`FirehoseConsumer` dispatches by routing key.

**Two logical databases, one MySQL instance** (ADR-034). Every operational context shares
`retail_db` (`DATABASE_URL`); the event store owns `ris_eventstore`
(`EVENTSTORE_DATABASE_URL`, via `DatabaseModule.forRootWithUrl`), created once per fresh
volume by `scripts/mysql-init/01-create-eventstore-db.sql`.

## Message patterns

Defined in `libs/contracts/microservices`, mirrored as `ROUTING_KEYS` in `libs/messaging`.
Wire format is dotted `<service>.<aggregate>.<action>` (ADR-008). A domain rejection throws
the module's `*DomainException` (`*ErrorCodeEnum`); the module's presentation
`*RpcExceptionFilter` maps it to HTTP. **Those filters are the authoritative code → status
tables.** Behaviour lives in the use case — read it, don't look for it here.

### Retail (`retail_queue`)

| Routing key | Use case | Controller |
| --- | --- | --- |
| `retail.cart.create` / `.get` / `.add-line` / `.change-line-quantity` / `.remove-line` / `.claim` | `CreateCart` / `GetCart` / `AddToCart` / `ChangeCartLineQuantity` / `RemoveFromCart` / `ClaimCart` | `cart.controller.ts` (6) |
| `retail.cart.place` | `PlaceOrderUseCase` | `orders.controller.ts` (12) |
| `retail.payment.capture` | `CapturePaymentUseCase` | ″ |
| `retail.order.get` / `.list` / `.cancel` / `.cancel-line` | `GetOrder` / `ListMyOrders` / `CancelOrder` / `CancelLine` | ″ |
| `retail.fulfillment.create` / `.list` / `.ship` / `.deliver` | `CreateFulfillment` / `ListFulfillments` / `ShipFulfillment` / `MarkDelivered` | ″ |
| `retail.refund.issue` / `.list` | `IssueRefund` / `ListRefundsForOrder` | ″ |
| `retail.return.open` / `.authorize` / `.reject` / `.receive` / `.inspect` / `.close` / `.get` / `.list` | `OpenReturnRequest` / `AuthorizeReturn` / `RejectReturn` / `ReceiveReturn` / `InspectAndDisposition` / `CloseReturn` / `GetReturn` / `ListReturnsForOrder` | `returns.controller.ts` (8) |

### Inventory (`inventory_queue`)

| Routing key | Use case |
| --- | --- |
| `inventory.stock-level.get` / `.receive` / `.adjust` / `.transfer` | `QueryAvailability` / `ReceiveStock` / `AdjustStock` / `TransferStock` |
| `inventory.location.list` | `ListLocations` |
| `inventory.stock-movement.list` | `ListStockMovements` |
| `inventory.reservation.reserve` / `.release` / `.allocate` | `ReserveStock` / `ReleaseReservation` / `AllocateStock` |
| `inventory.allocation.cancel` | `CancelAllocation` |
| `inventory.stock.commit-sale` | `CommitSale` |
| `inventory.stock.restock-from-return` | `RestockFromReturn` |

Served by `stock.controller.ts` (12 `@MessagePattern`). The reserve / allocate /
cancel-allocation / commit-sale / restock RPCs have **no gateway HTTP route** — retail
drives them.

### Catalog (`catalog_queue`)

| Routing key | Controller |
| --- | --- |
| `catalog.product.register` / `.publish` / `.archive` / `.list` / `.get`, `catalog.variant.create` / `.get` | `catalog.controller.ts` |
| `catalog.category.create` / `.reparent` / `.list` / `.get-tree` / `.list-products`, `catalog.product.reclassify` | `category.controller.ts` |
| `catalog.media.attach` / `.reorder` / `.detach` / `.list` | `media.controller.ts` |
| `catalog.price.set` / `.list` / `.select`, `catalog.tax-category.create` / `.list`, `catalog.variant.set-tax-category` | `pricing.controller.ts` (colocated `pricing` module) |

Category and media operations emit **no** events.

### Notification (`notification_events`)

`notification.template.author` / `.set-active` / `.list`;
`notification.delivery.list` / `.get` / `.record-outcome` / `.retry`;
`notification.marketing.send` — all on `notifications.controller.ts` (8).
`notification.health.ping` on `health.controller.ts`.
`record-outcome` is RPC-only by design (no gateway route — it is the ESP-webhook seam).

### Event consumers

| Consumer | Pattern | Dispatches to |
| --- | --- | --- |
| inventory `CatalogEventsConsumer` | `catalog.variant.created` | `AutoInitStockLevelUseCase` |
| retail `OrderCancelledConsumer` (`orders/infrastructure/consumers/`) | `retail.order.cancelled` on `retail_queue` | `IssueRefundUseCase` (auto-refund) |
| notification — six dispatch consumers | `inventory.stock.low`, `retail.order.placed`, `retail.order.cancelled`, `retail.fulfillment.shipped`/`.delivered`, the four `retail.return.*`, `retail.refund.issued` | `RenderAndDispatchUseCase` |
| notification `ConsentEventsConsumer` | `customer.consent.updated` / `customer.erased` | `CONSENT_CACHE` write-through / evict |
| event-store `FirehoseConsumer` (`modules/firehose.consumer.ts`) | `@EventPattern('#')` | `audit.staff.action` → `IngestAuditLogUseCase`; everything else → `IngestDomainEventUseCase` |

`FirehoseConsumer` sits at the **context root**, registered as a controller in
`AuditAndEventsModule` — it injects use cases from **both** sibling modules, and
`eslint-plugin-boundaries` only lets a module's `infrastructure/` inject its own.

**Reserved surfaces** (published, captured by the firehose, no business consumer):
`catalog.product.*`, `catalog.price.*`, `inventory.stock-level.initialized`,
`inventory.stock.{received,adjusted,reserved,allocated,released,committed,returned}`,
`inventory.stock-movement.recorded`, `retail.cart.*`,
`retail.payment.{authorized,captured}`, `retail.fulfillment.created`,
`retail.refund.failed`, `retail.return.{rejected,closed}`, `notifications.delivery.failed`.

## Service Structure

Every service uses the **per-module hexagonal layout** (`domain/` → `application/` (ports +
use-cases) → `infrastructure/` (persistence + messaging) → `presentation/`). The
notification module is the canonical template. The Nest module file sits under
`infrastructure/` **except in catalog**, where it sits at the module root.

**Boundary rule:** `ClientProxy` from `@nestjs/microservices` is allowed *only* inside
`infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`. Controllers, use cases, and
pipes inject the port symbol instead. Adapters use `ROUTING_KEYS`, not the legacy
`MicroserviceMessagePatternEnum`.

ADRs: gateway ADR-009; notification ADR-011; inventory ADR-027; retail ADR-013/028;
catalog ADR-004/018/025; pricing ADR-026.

### API Gateway (`apps/api-gateway/src/`)

`main.ts` first import is the tracer. `app/app.module.ts` wires the top module +
`CorrelationMiddleware` + two global `APP_FILTER`s: `app/filters/duplicate-key-exception.filter.ts`
(MySQL dup-entry → `409`) and `common/filters/optimistic-lock.exception-filter.ts`
(`OptimisticLockVersionMismatchError` → `409 VERSION_MISMATCH`).
`common/utils/throw-rpc-error.util.ts` forwards an RPC rejection's typed `code` +
object-valued `details` to the HTTP client verbatim.
`common/decorators/` holds the reusable `@IdempotencyKey()` and `@IfMatch()` param decorators.

Each RPC-fronting module has `application/ports` (`*_GATEWAY_PORT`),
`application/use-cases`, `infrastructure/messaging` (the sole `ClientProxy` holder), and
`presentation`. Gateway use cases resolve the staff override from
`@CurrentUser().permissions` and fold `@CurrentUser().id` into the command (ADR-028).

| Module | Routes | Notes |
| --- | --- | --- |
| `modules/cart/` | `/api/cart` | `cart.controller.ts`; owner-check, no permission code; Place requires `@IdempotencyKey()`; the three line routes accept `@IfMatch()` |
| `modules/catalog/` | `/api/catalog` | three one-aggregate controllers (`catalog` / `category` / `media`); DTOs reuse `validation.constants.ts` (`SLUG_PATTERN`, `parseBooleanQuery`) |
| `modules/inventory/` | `/api/inventory` | `inventory.controller.ts` |
| `modules/orders/` | `/api/orders` | `orders.controller.ts` + sibling `refunds.controller.ts` |
| `modules/returns/` | `/api/returns/*`, `/api/orders/:orderId/returns` | `returns.controller.ts` (empty-prefix `@Controller()`) |
| `modules/notifications/` | `/api/notifications` | `notifications.controller.ts`; all staff-only |
| `modules/auth/` | `/api/auth/*` | the only gateway module with real `domain/` + DB rows |
| `modules/iam/` | `/api/iam/*` | admin shell over the auth aggregates; **no `domain/`** |
| `modules/customer-admin/` | `/api/admin/customers/*` | admin shell over `Customer`; **no `domain/`** |

**`modules/auth/`** (ADR-010/024/037) — aggregates `StaffUser`, `Customer`,
`RoleAggregate`, `PermissionAggregate`, plus `ConsentRecord` (a plain framework-free class,
1:1 with `Customer`, no `BaseEntity`).
Ports: `STAFF_USER_REPOSITORY`, `CUSTOMER_REPOSITORY`, `ROLE_REPOSITORY`,
`PERMISSION_REPOSITORY`, `CONSENT_RECORD_REPOSITORY`, `CUSTOMER_EVENTS_PUBLISHER`,
`CUSTOMER_ERASURE_WRITER` (gateway-owned raw-SQL one-transaction PII nuller over `retail_db`),
`ITokenPort`, `IPasswordPort`.
Use cases: `Login`, `LoginCustomer`, `RegisterCustomer`, `CreateGuestSession`,
`RegisterStaffUser`, `RefreshToken`, `Logout`, `ValidateJwtSubject` (consumed by
`libs/auth`'s `JwtStrategy` through `AUTH_USER_VALIDATOR`), `GetCurrentCustomer`,
`RecordConsent`, `ReadConsent`, `EraseCustomer`.
Infra: TypeORM repos, `jwt-token.adapter`, `argon2-password.adapter`,
`rmq-audit-log.publisher` (the real `AUDIT_LOG_PUBLISHER`),
`rmq-customer-events.publisher`, `customer-erasure-writer.adapter`.
`auth.module.ts` re-exports the repository tokens + `AUDIT_LOG_PUBLISHER` +
`ReadConsentUseCase` + `EraseCustomerUseCase` (the two admin shells resolve them).
Controllers: `staff-login`, `auth`, `customer-auth`, `customer-consent`, `auth-admin`.

**Authentication conventions.** Three global guards via `APP_GUARD`: `JwtAuthGuard` →
`RolesGuard` → `PermissionsGuard`. Opt out with `@Public()`. `@RequiresPermission(<code>)`
is the precise gate; `@Roles(<RoleEnum>)` is coarse role-bundle gating (rare). Inject the
user with `@CurrentUser()`. `PermissionCodeEnum`
(`libs/contracts/auth/permission.enum.ts`) is the single source of truth. Customer tokens
carry **no** `permissions` claim — a code-gated route is staff-only by construction, and a
permission code is a *staff override over an owner-check*, never a customer gate.

### Microservices

**catalog** `modules/catalog/` (ADR-004/025/029)
Aggregates: `Product` (owns `ProductVariant`), `Category` (materialized `path`),
polymorphic `MediaAsset` (`(ownerType, ownerId)`, **no FK** on `owner_id`).
`CatalogDomainException` + `CatalogErrorCodeEnum`. Events: `VariantCreated`,
`ProductPublished`, `ProductArchived`.
Ports: `CATALOG_REPOSITORY`, `CATEGORY_REPOSITORY`, `MEDIA_ASSET_REPOSITORY` (a port per
aggregate seam), `CATALOG_EVENTS_PUBLISHER`, `ACTIVE_PRICE_PROBE` (parameterized `price`
read — no pricing import), `CATALOG_DEFAULT_CURRENCY`.
Use cases: `Register`/`AddVariant`/`Publish`/`ArchiveProduct`, `ListProducts`/
`GetProductBySlug`/`GetVariant`; `CreateCategory`/`ReparentCategory`/`ListCategories`/
`GetCategoryTree`/`ListCategoryProducts`/`ReclassifyProduct`; `AttachMedia`/`ReorderMedia`/
`DetachMedia`/`ListMedia`.
Infra: `catalog-rabbitmq.publisher.ts` (only `ClientProxy` site; two clients).
`variantId` is the downstream backbone key. `product_categories` is a bare N↔M join with
**no entity** (repository-maintained `INSERT IGNORE` / `DELETE`).

**pricing** `modules/pricing/` (ADR-026) — colocated in `catalog-microservice`, shares
`catalog_queue`, keys on the same `variantId`. *Not* a separate deployable.
Domain: framework-free `Price` (append-only ledger), `TaxCategory`,
`PricingDomainException` + `PricingErrorCodeEnum`.
Port: `PRICING_REPOSITORY` — `appendPrice` closes the predecessor + inserts the successor in
one tx; `attach`/`findVariantTaxHeader` use parameterized SQL through the injected manager,
**never** importing the catalog entity.
Infra: `pricing-rabbitmq.publisher.ts`. No `CacheModule`.
Both catalog modules share one connection:
`DatabaseModule.forRoot([...catalogEntities, ...pricingEntities])`.

**inventory** `modules/stock/` (ADR-027/030/031/032) — keyed on the opaque catalog `variantId`.
Aggregates: `StockLevel` (per-location running totals; `available` a pure getter; `version`),
`StockLocation` (caller-assigned string PK), `Reservation` (TTL hold; app-generated
`CHAR(36)` UUID; all-statuses UNIQUE `(cartId, variantId, stockLocationId)`), plus the
immutable `StockMovement` ledger record (frozen, fixed sign per type, no mutators).
`InventoryDomainException` (carries optional `details`) + `InventoryErrorCodeEnum`.
Events: `Stock{Received,Adjusted,Low}Event`, `StockLevelInitializedEvent`,
`Stock{Reserved,Released,Allocated,Committed,Returned}Event`.
Ports: `STOCK_REPOSITORY`, `RESERVATION_REPOSITORY`, `STOCK_MOVEMENT_REPOSITORY`
(`append` / `listByVariant` / `existsByReference` — no `save`/`update`/`delete`),
`STOCK_CACHE`, `STOCK_EVENTS_PUBLISHER`, `TRANSACTION_PORT` (opaque `ITransactionScope`),
`RESERVATION_TTL_MINUTES`, `OCC_RETRY_ATTEMPTS`.
Shared application helpers: `use-cases/stock-mutation.ts` (`runWithStockWriteRetry`,
`applyOnHandChange`), `reservation-mutation.ts`, `low-stock.emitter.ts`,
`movement-recorded.emitter.ts`, `stock-write-conflict.error.ts`, `stock-location.guard.ts`,
the view factories.
Infra: `persistence/` (4 entities/mappers; `StockMovementTypeormRepository` implements the
port **directly**; `TypeormTransactionAdapter`), `cache/stock.cache.ts` (`getOrLoad` +
`withInvalidation`), `consumers/catalog-events.consumer.ts`,
`messaging/stock-rabbitmq.publisher.ts` (two clients).
Presentation: `stock.controller.ts` + `inventory-rpc-exception.filter.ts`.

**retail** `modules/cart/` (ADR-028) — the mutable checkout side.
`Cart extends AggregateRoot<string|null>` (`CHAR(36)` UUID) owns `CartLine`.
`CartDomainException` + `CartErrorCodeEnum`.
Ports: `CART_REPOSITORY`, `CART_CATALOG_GATEWAY`, `CART_INVENTORY_GATEWAY`,
`CART_EVENTS_PUBLISHER`, `OCC_RETRY_ATTEMPTS`.
Use cases: `CreateCart`/`GetCart`/`AddToCart`/`ChangeCartLineQuantity`/`RemoveFromCart`/
`ClaimCart`, plus the shared `loadOwnedCart` owner-check and
`use-cases/cart-write.ts` (`runWithCartWriteRetry`, `assertCartVersion`,
`CartWriteConflictError`).
Infra: `persistence/` (`CartTypeormRepository` — one-tx version-checked root CAS → line
reconciliation → re-read), three `ClientProxy` adapters (`cart-catalog`, `cart-inventory`,
`cart-rabbitmq.publisher`).
Presentation: `cart.controller.ts` + `cart-rpc-exception.filter.ts` (forwards `details`).

**retail** `modules/orders/` (ADR-028/031/032/036) — the immutable checkout side.
**Five sibling aggregates:** `Order` (owns `OrderLine`), polymorphic `Address`
(`ownerType ∈ {customer, order}`), `Payment`, `Fulfillment` (owns `FulfillmentLine`),
`Refund`. One throwable for all of them: `OrderDomainException` + `OrderErrorCodeEnum`.
Ports: `ORDER_REPOSITORY`, `ADDRESS_REPOSITORY`, `PAYMENT_REPOSITORY`,
`FULFILLMENT_REPOSITORY` (its `findByIdForUpdate` is a `SELECT … FOR UPDATE` re-read),
`REFUND_REPOSITORY`, `PAYMENT_GATEWAY` (`authorize`/`capture`/`refund`, no transport import
— bound to `FakePaymentGatewayAdapter`), `TRANSACTION_PORT`, `ORDER_CART_READER` (raw SQL
over the cart tables), `ORDER_CATALOG_GATEWAY`, `ORDER_INVENTORY_GATEWAY`,
`ORDER_COMMIT_SALE_GATEWAY`, `ORDER_EVENTS_PUBLISHER`, `ORDER_CUSTOMER_CONTACT_READER`,
`AUDIT_LOG_PUBLISHER` (reused from `libs/contracts/auth`), `IDEMPOTENCY_STORE`,
`IDEMPOTENCY_KEY_TTL_HOURS`, `OCC_RETRY_ATTEMPTS`.
Use cases: `PlaceOrder`, `AuthorizePayment`, `CapturePayment`, `GetOrder`, `ListMyOrders`,
`CreateFulfillment`, `ListFulfillments`, `ShipFulfillment`, `MarkDelivered`, `CancelOrder`,
`CancelLine`, `IssueRefund`, `ListRefundsForOrder`, `PurgeExpiredIdempotencyKeys`; plus
`order-write.ts` (`runWithOrderWriteRetry`, `OrderWriteConflictError`), `order-access.ts`,
`fulfillment-quantities.ts`, `resolve-customer-email.ts`, `retry-then-log-for-replay.ts`,
`cancel-allocation-retry.ts`, the view factories.
Infra: `persistence/`, `payment-gateway/`, `messaging/`, `audit/`, `consumers/`
(`order-cancelled.consumer.ts`), `idempotency/` (`IdempotencyPurgeScheduler`,
`@Cron(EVERY_10_MINUTES)`; `ScheduleModule.forRoot()` is wired in `orders.module.ts`).
Presentation: `orders.controller.ts` + `orders-rpc-exception.filter.ts`.

**retail** `modules/returns/` (ADR-032) — the RMA bounded context (a separate module, not a
sibling in `orders/`).
`ReturnRequest extends AggregateRoot<number|null>` owns `ReturnLine`. `customerId` is the
gateway's **`CHAR(36)` UUID** (not a BIGINT, despite `orderId`/`orderLineId` being BIGINTs).
`ReturnDomainException` + `ReturnErrorCodeEnum`.
Ports: `RETURN_REQUEST_REPOSITORY`, `RETURN_ORDER_READER` (raw SQL over `order` /
`order_line` / `fulfillment` — never imports `orders/`), `RETURN_EVENTS_PUBLISHER`,
`INVENTORY_RESTOCK_GATEWAY`, `RETURN_CUSTOMER_CONTACT_READER`, `TRANSACTION_PORT`,
`RETURN_WINDOW_DAYS`, `OCC_RETRY_ATTEMPTS`.
Use cases: `OpenReturnRequest`, `AuthorizeReturn`, `RejectReturn`, `ReceiveReturn`,
`InspectAndDisposition`, `CloseReturn`, `GetReturn`, `ListReturnsForOrder`; plus
`return-write.ts` (`runWithReturnWriteRetry`, `ReturnWriteConflictError`),
`return-access.ts`, `return-view.factory.ts`, and a **local copy** of
`retry-then-log-for-replay.ts` (returns cannot import `orders/`).
Presentation: `returns.controller.ts` + `return-rpc-exception.filter.ts`.

**notification** `modules/notifications/` (ADR-011/033/037) — RMQ-only.
Domain: `Notification` VO, `NotificationTemplate`, `NotificationDelivery`,
`NotificationDomainException` + `NotificationErrorCodeEnum`.
Ports: `NOTIFIER` (`LogNotifierAdapter` by default; `FlakyLogNotifierAdapter` when
`NOTIFIER_TEST_FLAKY`), `TEMPLATE_RENDERER` (`HandlebarsTemplateRendererAdapter` — the only
`handlebars` import), `NOTIFICATION_TEMPLATE_REPOSITORY`, `NOTIFICATION_DELIVERY_REPOSITORY`,
`NOTIFICATION_EVENTS_PUBLISHER`, `CONSENT_READER` (raw SELECT over the shared
`consent_record`), `CONSENT_CACHE`, `MAX_DELIVERY_ATTEMPTS`, `OPS_NOTIFICATIONS_EMAIL`,
`CONSENT_CACHE_TTL_SECONDS`.
Use cases: `AuthorTemplate`, `SetTemplateActive`, `ListTemplates`, `ListDeliveries`,
`GetDelivery`, `RecordDeliveryOutcome`, `RetryDelivery`, `RetryFailedDeliveries`,
`SendMarketing`, and **`RenderAndDispatchUseCase`** — the single persist-then-send pipeline
every consumer calls; plus `transactional-event-types.ts`, `transport-subject.ts` and the
view factories.
Infra: `persistence/`, `consumers/` (seven; `dispatch-customer-email.ts` is the shared
missing-recipient skip), `delivery/` (`log` / `email` / `webhook` notifier adapters),
`render/`, `cache/consent.cache.ts`, `messaging/notification-rabbitmq.publisher.ts`,
`scheduling/delivery-retry.scheduler.ts` (`@Interval`).
`app.module.ts` wires `CacheModule` (this service's first) + `DatabaseModule.forRoot(notificationEntities)`.
Presentation: `health.controller.ts`, `notifications.controller.ts`,
`notification-rpc-exception.filter.ts`.
Seeds: `scripts/seeds/notification-template.sql` (eleven active `v1` `email`/`en-US` rows),
`scripts/seeds/consent-record.sql`.

**event-store** `modules/audit-and-events.module.ts` (ADR-034/035) — RMQ-only, no HTTP,
**its own** DB `ris_eventstore` via
`DatabaseModule.forRootWithUrl([DomainEventEntity, AuditLogEntryEntity], 'EVENTSTORE_DATABASE_URL')`.
One bounded context (`audit-and-events`) split into two sibling modules: `domain-events/`
(→ `domain_event`) and `audit-log/` (→ `audit_log_entry`).
Domain: `DomainEvent` and `AuditLogEntry` are **frozen value objects** (every field
`public readonly`, `Object.freeze`d, `create` / `reconstitute` factories, no mutators, no
domain events, **not** `AggregateRoot`s). Invariants throw a plain `Error`.
`AuditActorType` is domain-local, not a `libs/contracts` enum.
Ports: `DOMAIN_EVENT_REPOSITORY` (`append` → `{ inserted }`; swallows the composite-UNIQUE
`ER_DUP_ENTRY` via an **inlined** `isDuplicateEntryError`) and `AUDIT_LOG_REPOSITORY`
(`append`). **Both ports are `append`-only** — no read, no `save`/`update`/`delete`. Both
implement the port directly, `insert`-only, and are the sole `@InjectRepository` sites.
Use cases: `IngestDomainEventUseCase`, `IngestAuditLogUseCase`, plus
`firehose-extractors.ts` (heuristic `producer` / `aggregateType` / `aggregateId`).
Consumer: `modules/firehose.consumer.ts`. **No `presentation/` layer** — nothing reads the
two logs back; inspect `ris_eventstore` with SQL.
Migrations: `1782521938896-CreateDomainEventTable`, `1782521942829-CreateAuditLogEntryTable`
(eventstore pipeline).

## Shared Libraries

Imported via the path aliases in `tsconfig.json` as `@retail-inventory-system/<name>`.

| Library | Contents |
| --- | --- |
| `contracts` | `microservices/` (queue / pattern / client-token / app-name enums, `ICorrelationPayload`), `auth/` (`RoleEnum`, `PermissionCodeEnum`, `ICurrentUser`, `IJwt{Access,Refresh}Payload`, `IAuditLogPublisher` + `AUDIT_LOG_PUBLISHER`, `IAuditStaffActionEvent`, `ConsentRecordView`, the two `customer.*` events), `retail/`, `inventory/`, `catalog/`, `notifications/`. Plain TS; class-validator / Swagger decorators are the documented DTO exception. |
| `auth` | `AuthModule.forRootAsync({ imports, providers, exports })` (Passport + JwtModule + `JwtStrategy` + the three guards, all global), `AUTH_USER_VALIDATOR`, `@Public` / `@Roles` / `@RequiresPermission` / `@CurrentUser`, runtime `RoleEnum` re-export. |
| `database` | `BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy`, `DatabaseModule.forRoot(entities)` / `.forFeature(entities)` / `.forRootWithUrl(entities, urlEnvVar)`. Apps call `forRoot` at `AppModule` level; per-module registration prefers `forFeature` (auth uses inline `TypeOrmModule.forFeature` — ADR-019). |
| `messaging` | `MessagingModule`, `MicroserviceClient{Retail,Inventory,Notification,Catalog}Module` + `MicroserviceClientRisEventsModule` (`RIS_EVENTS_PUBLISHER`), `MicroserviceClientConfiguration`, `RabbitmqClientFactory`, `RisEventsMirrorPublisher`, `ROUTING_KEYS` (incl. `AUDIT_STAFF_ACTION`), `EXCHANGES`. |
| `cache` | `ICachePort` (`get`/`set`/`del`/`wrap`/`delByPrefix`/`singleFlight`), `CACHE_PORT`, `RedisCacheAdapter` (OTel spans), `CacheModule` (`@Global()`, register once at root), `@Cacheable()`, the `CACHE_KEYS` registry, `CacheHelper`. |
| `observability` | `LoggerModuleConfig` (Pino + redaction + the `logMethod` hook injecting `traceId`/`spanId`), `CorrelationMiddleware`, `CorrelationId`, `CORRELATION_ID_HEADER`, `tracer.ts`, `TraceContextInterceptor` / `MetricsModule` (placeholders). |
| `ddd` | `Entity<TId>`, `AggregateRoot<TId>` (`pullDomainEvents()`), `ValueObject<TProps>`, `DomainEvent<TAggregateId>`, `IRepositoryPort`. **No `@nestjs/*`, no TypeORM.** |
| `common` | `Result<T, E>`, `DomainException`, `IPage` / `IPageRequest`, `Maybe` / `Nullable`, `bodyFingerprint` (canonical-JSON + SHA-256, under `idempotency/`; Node `crypto` only). |
| `config` | `configModuleConfig` (the Joi env schema). No Nest-binding helpers. |

**Cache keys** live in `libs/cache/cache-keys.ts`. `INVENTORY_STOCK_KEY_VERSION` is `v3`;
`NOTIFICATIONS_CONSENT_KEY_VERSION` is `v1`; the rest are `v1`. Consumed builders today:
`inventoryStock(...)` and `notificationsConsent(customerId)`. The `catalogPrice`,
`catalogCategory*`, `catalogProduct*`, `retailOrder`, and `notificationsTemplate*` builders
are **reserved** (no caller).

## Conventions & boundaries (authoritative — ADR-017)

The per-layer / per-lib import constraints plus cross-service and cross-module isolation are
enforced by `eslint-plugin-boundaries` in `eslint.config.mjs`. When unsure where a file
belongs, run `yarn lint`; **do not weaken a rule to make code pass.** The bumper is
`spec/architecture-lint.spec.ts` — a fixture per rule that intentionally violates it and
asserts the expected `boundaries/*` ruleId fires.

**Forbidden imports.** Domain code (`apps/*/src/.../domain/` and `libs/ddd`) MUST NOT import
`@retail-inventory-system/{messaging,cache,observability,database}` or any `@nestjs/*`.
Reach those via ports. The `application-use-case` denylist forbids both `@nestjs/typeorm`
and bare `typeorm`.

**Recurring patterns.**

- One throwable per module (`*DomainException` + `*ErrorCodeEnum`), mapped by one
  `*RpcExceptionFilter`.
- A separate repository **port per aggregate seam** (`ACTIVE_PRICE_PROBE`,
  `CATEGORY_REPOSITORY`, `RESERVATION_REPOSITORY` are the precedent).
- Cross-module reads go through a raw-parameterized-SQL **reader port** rather than
  importing the other module's entities (`ORDER_CART_READER`, `RETURN_ORDER_READER`,
  `CONSENT_READER`, the customer-contact readers).
- A gateway adapter wraps a rejection in `RpcException(err)` so the upstream
  `{ code, details }` reaches the gateway verbatim.
- A human-facing number (`order_number`, `rma_number`) is finalized from the generated id
  via the "re-read then finalize a derived field" idiom.
- Ports named after the consuming module when two modules need the same seam
  (`ORDER_INVENTORY_GATEWAY` vs `CART_INVENTORY_GATEWAY`).

**Cache-key convention** (ADR-016 + ADR-022). Keys follow
`ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`. Apps under `apps/*/src`
MUST NOT write cache-key string literals (call a `CACHE_KEYS` builder) and MUST NOT import
`@nestjs/cache-manager` / `@keyv/redis` / `cacheable` directly (depend on `ICachePort` /
`CACHE_PORT`). Write paths invalidate via `CACHE_KEYS.<aggregate>Prefix` + `delByPrefix`,
awaited post-commit. On stock this is type-enforced (ADR-023): `IStockCachePort` has no
public `invalidate` — route writes through `withInvalidation(work, resolveItems, opts)`.

## Database

MySQL via TypeORM. Migration config is in `migrations/config/data-source.ts`; the event
store's is `migrations/config/eventstore-data-source.ts` (globs `migrations/eventstore/*`,
separate `migrations` ledger). Entities live next to the bounded context that owns them.

### `retail_db` — table ownership

| Owner | Tables |
| --- | --- |
| gateway `auth` | `staff_user`, `customer`, `role`, `permission`, `role_permissions`, `staff_user_roles`, `consent_record` |
| catalog `modules/catalog/` | `product`, `product_variant`, `category`, `media_asset`, plus the bare `product_categories` join (no entity) |
| catalog `modules/pricing/` | `price` (generated-column UNIQUE `open_scope_key`), `tax_category` |
| inventory `modules/stock/` | `stock_location`, `stock_level`, `reservation`, `stock_movement` |
| retail `modules/cart/` | `cart`, `cart_line` |
| retail `modules/orders/` | `order`, `order_line`, `address`, `payment`, `fulfillment`, `fulfillment_line`, `refund`, `idempotency_key` |
| retail `modules/returns/` | `return_request`, `return_line` |
| notification | `notification_template`, `notification_delivery` |

**Cross-context FKs:** `cart.customer_id` / `order.customer_id` → `customer` (the latter
nullable — a tombstone); `*_line.variant_id` → `product_variant`;
`order.source_cart_id` → `cart`; `order.billing/shipping_address_id` → `address`;
`payment.order_id` → `order`; `product_variant.tax_category_id` → `tax_category`
(`ON DELETE SET NULL`); `consent_record.customer_id` → `customer` (`ON DELETE CASCADE`);
`category.parent_id` self-FK (`ON DELETE SET NULL`).

`media_asset.owner_id` and `stock_movement.reference_id` are **polymorphic and FK-less**.
`customer.email` and the five `address` PII columns are **nullable** so an erase can null
them in place (ADR-037).

### `ris_eventstore`

`domain_event` (composite UNIQUE `(producer, event_type, aggregate_id, occurred_at,
correlation_id)`) and `audit_log_entry` (no dedupe key). **Neither extends `BaseEntity`** —
no `updated_at` / `deleted_at` at all, only `received_at` beside `occurred_at`.

Run `docker-compose up` for MySQL, RabbitMQ, and Redis locally; add
`-f docker-compose.observability.yml` for the OTel collector + Jaeger.

## Architecture decisions (ADRs)

Rules and target state live as ADRs under [`docs/adr/`](docs/adr/) — see
[`docs/adr/index.md`](docs/adr/index.md). ADRs are the durable record (3-digit padding,
`001-…`; **next free number is `038`**). When making an architectural decision, write an
ADR — Nygard hybrid (Status, Context, Decision, Alternatives, Consequences), one decision
per file, slug describes the decision not the area (ADR-003). Do not edit an accepted ADR
beyond flipping its `Status` and adding a pointer; if a decision is reversed, write a new
one that **supersedes** it.

Per-capability walkthroughs live under [`docs/implementation/`](docs/implementation/),
numbered by delivery order. Point-in-time review findings live under
[`docs/audits/`](docs/audits/).

**No outstanding architectural exceptions.** The old `ARCH-LINT-EX-01` is closed by the
`ITransactionPort` / opaque `ITransactionScope` abstraction; the `EntityManager` downcast
lives only in `TypeormTransactionAdapter` and `StockTypeormRepository` (ADR-017 §6, ADR-019).
