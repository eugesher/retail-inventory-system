# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working with code in this repository.

**A map, not a manual.** *What exists and where*, plus constraints and landmines. Operation
mechanics, business rules, rationale, and history belong in the code, each module's
`*RpcExceptionFilter`, [`docs/adr/`](docs/adr/), and [`README.md`](README.md). Cite them; never
summarise them here — a stale copy is worse than none, because an agent trusts this file.

**Nothing cites this file.** References point *out* of it, never *in*: no code comment, no ADR,
no doc under [`docs/`](docs/), no `README.md`, no request fixture may name `CLAUDE.md` or link to
it. It is a derived index — it can be rewritten, re-cut, or regenerated wholesale, and an
inbound citation turns that into a broken promise. Cite the thing this file points at (the ADR,
the source file, the Joi schema); if there is nothing to point at, the fact belongs somewhere
citable first.

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

Non-obvious facts, each worth a debugging cycle.

**Boot / observability**

- `main.ts`'s **first import MUST be** `@retail-inventory-system/observability/tracer`.
  OTel auto-instrumentation patches at module load; anything `require()`d before it is
  invisible to tracing.
- `NestFactory.createMicroservice` returns an `INestMicroservice`, which cannot
  `connectMicroservice`. A second transport forces the hybrid `NestFactory.create` form — as in
  `apps/event-store-microservice/src/main.ts`, the only one. It must `await app.init()`
  **first** (`startAllMicroservices()` will not fire `onModuleInit`), and must **never**
  `listen()`.
- Never call `PinoLogger.assign()` inside an `@EventPattern` handler — those are not
  request-scoped and it throws. Log `correlationId` inline (ADR-011 §7).

**RabbitMQ**

- **Never rethrow from an `@EventPattern`** — the broker blind-redelivers in a hot loop.
- The firehose binds a **lone `#`**, not `#.#`. RabbitMQ routes both, but Nest's
  `matchRmqPattern` nacks every multi-word routing key under `#.#`.
- **Producer targets the consumer's queue** (ADR-008/020): an event is emitted onto the
  queue of whoever consumes it, not the producer's own.
- `RisEventsMirrorPublisher.mirror` is non-throwing best-effort, ordered **after** the
  primary `emit`.
- A single Nest app binds every handler pattern to every connected transport. Two queues with
  disjoint **`@EventPattern`** sets in one app is therefore not supported; an **event** queue
  plus an **RPC** queue is (ADR-039 §, which explains why). Fallout: the other queue's patterns
  appear as inert bindings in the RabbitMQ UI.

**Persistence**

- MySQL treats `NULL`s as distinct inside a UNIQUE. `domain_event.correlation_id` is `NOT NULL DEFAULT ''`
  (`IngestDomainEventUseCase` coalesces an empty one to `''`) — an event ingested without one is
  reachable by **no** `correlationId` filter and by no trace.
  `audit_log_entry.correlation_id` is nullable, and a `WHERE correlation_id = ?` never
  matches a null row either.
- `audit_log_entry.action` holds the `IAuditLogEvent.name` string (`StaffUserRolesAssigned`,
  `RefundIssued`) — **never** a `PermissionCodeEnum` value. A permission code in an `?action=`
  filter is a well-formed query that matches nothing.
- TypeORM **drops** an `undefined` from a `where` clause instead of matching nothing:
  `find({ where: { correlationId: undefined } })` is an unbounded `SELECT *`. A `@MessagePattern`
  has no pipe in front of it, so the use case must reject a blank filter itself
  (`TraceByCorrelationUseCase`); a gateway DTO guards only the HTTP caller.
- `new Date('2026-06-01T00:00:00')` (no `Z`, no `±hh:mm`) resolves in the **Node host's local
  zone**; `new Date('2026-06-01')` resolves as UTC. `timezone: 'Z'` does not reach this — it is
  `Date` parsing, not driver serialization. `@IsISO8601()` accepts the zone-less form, so pin a
  `from`/`to` bound to UTC before parsing (the event store's `parseInstant`, the gateway's
  `IsOnOrAfter`).
- Append-only tables (`stock_movement`, `domain_event`, `audit_log_entry`,
  `idempotency_key`) implement their repository port **directly**, never through
  `BaseTypeormRepository`.
- `condition` is a MySQL reserved word — backticked in the `return_line` migration.
- Never annotate an `<x>Entities` const with `TypeOrmModuleOptions['entities']` — a *parameter*
  type (`MixedList | undefined`), so the value stops being spreadable and stops satisfying
  `forFeature`. Leave it unannotated (note on `DatabaseModule.forRoot`).
- `order_line.quantity` never shrinks; the units still owed are `OrderLine.activeQuantity`
  (`quantity − cancelled_quantity`, ADR-040).
  Using `quantity` re-releases cancelled units against the **shared** per-`(variant,
  location)` `quantity_allocated`.
- `reservation.cart_id` is overridden to `utf8mb4_unicode_ci` to match the retail `cart`
  column's collation.
- `DatabaseModule.forRoot` pins `mysql2` to UTC (`timezone: 'Z'`); without it the driver
  falls back to the Node host's local zone and the pricing publish probe's
  `price.valid_from` vs `UTC_TIMESTAMP()` comparison skews.

**Validation**

- `@IsOptional()` skips a property's validators for `null` as well as `undefined`, and
  `whitelist` does not strip a decorated `null`, so `{"batchSize": null}` clears a
  `@IsInt() @Min(1)` DTO. `Math.trunc(null)` is `0`, not `NaN`, so a use case reading "absent"
  as `=== undefined` mishandles it — test `typeof x !== 'number'`
  (`SweepExpiredReservationsUseCase.resolveLimit`).

**Config / DI**

- **A use case never reads `process.env`.** Config arrives through a value-provider token:
  `OCC_RETRY_ATTEMPTS`, `RESERVATION_TTL_MINUTES`, `RESERVATION_SWEEP_BATCH_SIZE`,
  `RESERVATION_SWEEP_TRANSACTION_SIZE`, `RESERVATION_SWEEP_INTERVAL_SECONDS`,
  `RETURN_WINDOW_DAYS`,
  `IDEMPOTENCY_KEY_TTL_HOURS`, `CAPTURE_CLAIM_STALE_MINUTES`, `MAX_DELIVERY_ATTEMPTS`, `OPS_NOTIFICATIONS_EMAIL`,
  `CONSENT_CACHE_TTL_SECONDS`, `CATALOG_DEFAULT_CURRENCY`, `RETAIL_DEFAULT_CURRENCY`,
  `HEALTH_PROBE_TIMEOUT_MS`. The sole exception is
  `NOTIFIER_TEST_FLAKY` (test-only).
  `CATALOG_DEFAULT_CURRENCY` and `RETAIL_DEFAULT_CURRENCY` **deliberately read the one
  `DEFAULT_CURRENCY` var**: a catalog quoting EUR and a cart opening in USD bakes the wrong
  unit into an immutable `Order.currency`. A third reader still mints its own literal —
  `PriceQueryDto.currency = 'USD'` defaults the price-read endpoints at the gateway edge.
  `RESERVATION_SWEEP_INTERVAL_SECONDS` is the one an **infrastructure** class injects, so
  `ReservationSweepScheduler` registers its timer via `SchedulerRegistry.addInterval` in
  `onModuleInit` — and **must** `deleteInterval` in `onModuleDestroy`, or a leaked timer hangs
  the Jest e2e worker.
- A new `PermissionCodeEnum` member auto-seeds to the `admin` role **only if** it is also
  added to `PERMISSION_SEEDS` in `scripts/test-db-seed.ts`.
- `EVENTSTORE_DATABASE_URL` is a **required** Joi key in the shared schema, so it must be
  set for every service — but only the event store opens it.

**Repo**

- `.env.local` **is git-tracked** (CI reads it), but `.env.example` is **not** — `.gitignore`'s
  `.env.*` glob swallows it and only `.env.local` is force-tracked. An edit to `.env.example`
  never shows up in `git status`; do not conclude it was missed.
- Bare `npx jest` fails with a Babel TypeScript parse error (not a code bug). Always pass
  `--config jest.unit.config.js`.
- `yarn lint` is the **source of truth for where a file belongs**. Never weaken a
  `boundaries/*` rule to make code pass.
- `boundaries` takes the **first** matching element pattern, so order in `boundariesElements`
  is load-bearing: `shared-module-barrel` (`modules/auth/index.ts`) must stay ahead of
  `nest-module` (`modules/*/*.ts`), which matches it too. Mirror any change into
  `spec/architecture-lint.spec.ts`, which **inlines its own copy** of the taxonomy — and note
  that **nothing checks the mirror**. That spec lints against its own copy, never against
  `eslint.config.mjs`, so weakening a production rule leaves all 74 of its tests green. It guards
  the plugin's behaviour, not your config.
- `test:infra:reload` runs **both** migration pipelines; `yarn migration:run` alone leaves
  `ris_eventstore` empty.

## Cross-cutting conventions

Four conventions bind code you may be touching. **Read the linked source before changing any
of them** — they are not restated here, on purpose.

| Convention | Where it is specified |
| --- | --- |
| Request-level idempotency on the four money-/stock-moving writes | ADR-036; [`README.md` §5](README.md#5-cross-cutting-guarantees) |
| Version-checked OCC on every aggregate write, bounded by `OCC_RETRY_ATTEMPTS` | ADR-036/045; `runWithOccRetry` (`libs/common/concurrency/`) — the module's `*-write.ts` only binds to it |
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
| `event-store-microservice` | `event_store_firehose_queue` (events) + `event_store_query_queue` (RPC) | `audit-and-events` context; its **own** DB `ris_eventstore` (ADR-034) |

**Queues:** `retail_queue`, `inventory_queue`, `notification_events`, `catalog_queue`,
`event_store_firehose_queue`, `event_store_query_queue`.

**Exchange:** `EXCHANGES.RIS_EVENTS_TOPIC` (`ris.events`) is the **one live** member
(`RETAIL`/`INVENTORY`/`NOTIFICATION` stay reserved, default-exchange-only). Every producer
dual-publishes onto it through `RisEventsMirrorPublisher` (ADR-035);
`event_store_firehose_queue` consumes it. `event_store_query_queue` is on the **default**
exchange and carries the three `audit.*` RPCs (ADR-039).

**Two logical databases, one MySQL instance** (ADR-034). Every operational context shares
`retail_db` (`DATABASE_URL`); the event store owns `ris_eventstore`
(`EVENTSTORE_DATABASE_URL`, via `DatabaseModule.forRootWithUrl`), created once per fresh
volume by `scripts/mysql-init/01-create-eventstore-db.sql`.

## Message patterns

`ROUTING_KEYS` (`libs/messaging`) mirrors `libs/contracts/microservices`. Wire format is dotted
`<service>.<aggregate>.<action>` (ADR-008), and the namespace names the queue:

| Namespace | Queue | Controller (`@MessagePattern`) |
| --- | --- | --- |
| `retail.cart.*` | `retail_queue` | `cart.controller.ts` (6) |
| `retail.{order,payment,fulfillment,refund}.*` | ″ | `orders.controller.ts` (12) |
| `retail.return.*` | ″ | `returns.controller.ts` (8) |
| `inventory.*` | `inventory_queue` | `stock.controller.ts` (13) |
| `catalog.{product,variant}.*` / `.category.*` / `.media.*` / `.price.*` + `.tax-category.*` | `catalog_queue` | `catalog.controller.ts` / `category.controller.ts` / `media.controller.ts` / `pricing.controller.ts` |
| `notification.{template,delivery,marketing}.*` | `notification_events` | `notifications.controller.ts` (8) |
| `audit.{event,entry}.query`, `audit.trace.by-correlation` | `event_store_query_queue` | `audit-query.controller.ts` (3) |
| `<svc>.health.ping` | that service's own queue | `apps/<svc>/src/app/health.controller.ts` |

Full routing-key → use-case tables: [`README.md` §2](README.md#2-architecture-at-a-glance).
Behaviour lives in the use case; the code → status table is the module's `*RpcExceptionFilter`.
Neither is restated here.

**Surprises.**

- The inventory `reservation.*` / `allocation.cancel` / `stock.commit-sale` /
  `stock.restock-from-return` RPCs have **no gateway HTTP route** — retail drives them. Same for
  `notification.delivery.record-outcome`.
- Catalog **category and media** operations emit **no** events.
- `audit.staff.action` is the one `audit.` **event**, not an RPC: it rides `ris.events` into the
  firehose queue and never reaches `audit-query.controller.ts` (ADR-039).
- Health handlers sit in `app/`, **not** a module — liveness belongs to the deployable — and do
  **no I/O** (liveness, not readiness). ADR-044.

### Event consumers

| Consumer | Pattern | Dispatches to |
| --- | --- | --- |
| inventory `CatalogEventsConsumer` | `catalog.variant.created` | `AutoInitStockLevelUseCase` |
| retail `OrderCancelledConsumer` | `retail.order.cancelled` on `retail_queue` | `IssueRefundUseCase` (auto-refund) |
| notification — six dispatch consumers | `inventory.stock.low`, `retail.order.placed`, `retail.order.cancelled`, `retail.fulfillment.shipped`/`.delivered`, the four `retail.return.*`, `retail.refund.issued` | `RenderAndDispatchUseCase` |
| notification `ConsentEventsConsumer` | `customer.consent.updated` / `customer.erased` | `CONSENT_CACHE` write-through / evict |
| event-store `FirehoseConsumer` | `@EventPattern('#')` | `audit.staff.action` → `IngestAuditLogUseCase`; everything else → `IngestDomainEventUseCase` |

A routing key that is published but absent from that table is a **reserved surface**: no
business consumer, still captured by the firehose. [`README.md`
§2](README.md#2-architecture-at-a-glance) enumerates them.

## Background jobs (cron)

**Five** timers, in three services (`*.scheduler.ts`); `ScheduleModule.forRoot()` is wired in each
one's Nest module (retail and notification own two each). Cadences, registering files and what a
missed tick costs:
[`README.md` §13](README.md#13-background-jobs).

## Service Structure

Every service uses the **per-module hexagonal layout** (`domain/` → `application/` (ports +
use-cases) → `infrastructure/` (persistence + messaging) → `presentation/`). The
notification module is the canonical template. The Nest module file is the module's
**composition root**, not a layer: it sits at `modules/<m>/<m>.module.ts` everywhere, no
exceptions (ADR-041). Element type `nest-module` — which also covers the module-root barrel.

**Boundary rule:** `ClientProxy` only inside `infrastructure/messaging/` — **enforced** by a
`no-restricted-imports` `importNames` rule, not by `boundaries`. Elsewhere, inject the port. Two filename forms: `<module>-rabbitmq.{adapter,publisher}.ts` and
`<seam>.rabbitmq.{adapter,publisher}.ts` (mirrors `<seam>.gateway.port.ts`). Adapters use
`ROUTING_KEYS`.

ADRs: gateway ADR-009; notification ADR-011; inventory ADR-027; retail ADR-013/028;
catalog ADR-004/018/025; pricing ADR-026.

### API Gateway (`apps/api-gateway/src/`)

`main.ts` first import is the tracer. `app/app.module.ts` wires the top module +
`CorrelationMiddleware` + two global `APP_FILTER`s:
`app/filters/duplicate-key-exception.filter.ts` and
`common/filters/optimistic-lock.exception-filter.ts`.
`common/utils/throw-rpc-error.util.ts` forwards an RPC rejection's `code` + `details` verbatim.
`common/decorators/` holds the reusable `@IdempotencyKey()` and `@IfMatch()` param decorators.

Each RPC-fronting module has `application/ports` (`*_GATEWAY_PORT`),
`application/use-cases`, `infrastructure/messaging`, and
`presentation`. Gateway use cases fold `@CurrentUser()` into the command (ADR-028).

| Module | Routes | Notes |
| --- | --- | --- |
| `modules/cart/` | `/api/cart` | `cart.controller.ts`; owner-check, no permission code; Place requires `@IdempotencyKey()`; the three line routes accept `@IfMatch()` |
| `modules/catalog/` | `/api/catalog` | three one-aggregate controllers (`catalog` / `category` / `media`); DTOs reuse `validation.constants.ts` (`SLUG_PATTERN`, `parseBooleanQuery`) |
| `modules/inventory/` | `/api/inventory` | `inventory.controller.ts` |
| `modules/orders/` | `/api/orders` | `orders.controller.ts` + sibling `refunds.controller.ts` |
| `modules/returns/` | `/api/returns/*`, `/api/orders/:orderId/returns` | `returns.controller.ts` (empty-prefix `@Controller()`) |
| `modules/notifications/` | `/api/notifications` | `notifications.controller.ts`; all staff-only |
| `modules/health/` | `/api/health` | `@Public()` RMQ fan-out to all five (ADR-044); the only module holding every `MicroserviceClient*Module` |
| `modules/audit/` | `/api/audit/*` | `audit.controller.ts`; three `GET`s, all `audit:read`; DTOs carry **no** `pageSize` cap and a local `IsOnOrAfter` cross-property validator |
| `modules/auth/` | `/api/auth/*` | the only gateway module with real `domain/` + DB rows |
| `modules/iam/` | `/api/iam/*` | admin shell over the auth aggregates; **no `domain/`**. Owns staff creation (`POST /api/iam/staff`, `iam:staff-create` — **not** `iam:assign`; ADR-047) by injecting auth's `RegisterStaffUserUseCase` through the `auth` barrel |
| `modules/customer-admin/` | `/api/admin/customers/*` | admin shell over `Customer`; **no `domain/`** |

**`modules/auth/`** (ADR-010/024/037) — aggregates `StaffUser`, `Customer`,
`RoleAggregate`, `PermissionAggregate`, plus `ConsentRecord` (a plain framework-free class,
1:1 with `Customer`, no `BaseEntity`).
Ports: `STAFF_USER_REPOSITORY`, `CUSTOMER_REPOSITORY`, `ROLE_REPOSITORY`,
`PERMISSION_REPOSITORY`, `CONSENT_RECORD_REPOSITORY`, `CUSTOMER_EVENTS_PUBLISHER`,
`CUSTOMER_ERASURE_WRITER` (gateway-owned raw-SQL PII nuller),
`ITokenPort`, `IPasswordPort`.
`ValidateJwtSubjectUseCase` is consumed by `libs/auth`'s `JwtStrategy` through
`AUTH_USER_VALIDATOR`. `auth.module.ts` re-exports the repository tokens + `AUDIT_LOG_PUBLISHER`
+ `ReadConsentUseCase` + `EraseCustomerUseCase` — the sanctioned seam the two admin shells
resolve through (`ARCH-LINT-EX-02`).

**Authentication conventions.** Three global guards via `APP_GUARD`: `JwtAuthGuard` →
`RolesGuard` → `PermissionsGuard`. Opt out with `@Public()`. `@RequiresPermission(<code>)`
is the precise gate; `@Roles(<RoleEnum>)` is coarse role-bundle gating (rare). Inject the
user with `@CurrentUser()`. `PermissionCodeEnum`
(`libs/contracts/auth/permission.enum.ts`) is the single source of truth. Who a code-gated
route admits: [`README.md` §7](README.md#7-authentication-and-authorization).

### Microservices

Per module: `ls` the four layers for its use cases, adapters and controllers — they are **not**
enumerated here. What is here is what `ls` will not tell you: the aggregates, the port symbols a
use case injects, and the surprises.

**catalog** `modules/catalog/` (ADR-004/025/029)
Aggregates: `Product` (owns `ProductVariant`), `Category` (materialized `path`),
polymorphic `MediaAsset` (**no FK** on `owner_id`).
`CatalogDomainException` + `CatalogErrorCodeEnum`. Events: `VariantCreated`,
`ProductPublished`, `ProductArchived`.
Ports: `CATALOG_REPOSITORY`, `CATEGORY_REPOSITORY`, `MEDIA_ASSET_REPOSITORY` (a port per
aggregate seam), `CATALOG_EVENTS_PUBLISHER`, `ACTIVE_PRICE_PROBE` (parameterized `price`
read — no pricing import), `CATALOG_DEFAULT_CURRENCY`.
`variantId` is the downstream backbone key. `product_categories` is a bare N↔M join with **no entity**.

**pricing** `modules/pricing/` (ADR-026) — colocated in `catalog-microservice`, shares
`catalog_queue`, keys on the same `variantId`. *Not* a separate deployable.
Domain: framework-free `Price` (append-only ledger), `TaxCategory`,
`PricingDomainException` + `PricingErrorCodeEnum`.
Port: `PRICING_REPOSITORY` — `appendPrice`; `attach`/`findVariantTaxHeader` use parameterized
SQL through the injected manager, **never** importing the catalog entity.
Both catalog modules share one connection:
`DatabaseModule.forRoot([...catalogEntities, ...pricingEntities])`.

**inventory** `modules/stock/` (ADR-027/030/031/032/038) — keyed on the opaque catalog `variantId`.
Aggregates: `StockLevel` (per-location running totals; `available` a pure getter; `version`),
`StockLocation` (caller-assigned string PK), `Reservation` (TTL hold; app-generated
`CHAR(36)` UUID; all-statuses UNIQUE `(cartId, variantId, stockLocationId)`), plus the
immutable `StockMovement` ledger record (fixed sign per type, no mutators).
`InventoryDomainException` (optional `details`) + `InventoryErrorCodeEnum`.
Events: `Stock{Received,Adjusted,Low}Event`, `StockLevelInitializedEvent`,
`Stock{Reserved,Released,Allocated,Committed,Returned}Event`.
Ports: `STOCK_REPOSITORY`, `RESERVATION_REPOSITORY`, `STOCK_MOVEMENT_REPOSITORY`
(`append` / `listByVariant` / `existsByReference` — no `save`/`update`/`delete`),
`STOCK_CACHE`, `STOCK_EVENTS_PUBLISHER`, `TRANSACTION_PORT`,
`RESERVATION_TTL_MINUTES`, `RESERVATION_SWEEP_BATCH_SIZE`,
`RESERVATION_SWEEP_TRANSACTION_SIZE`, `RESERVATION_SWEEP_INTERVAL_SECONDS`, `OCC_RETRY_ATTEMPTS`.
`SweepExpiredReservationsUseCase` (ADR-038) has two callers: `ReservationSweepScheduler` and
the `inventory.reservation.sweep` `@MessagePattern`.

**retail** `modules/cart/` (ADR-028) — the mutable checkout side.
`Cart extends AggregateRoot<string|null>` (`CHAR(36)` UUID) owns `CartLine`.
`CartDomainException` + `CartErrorCodeEnum`.
Ports: `CART_REPOSITORY`, `CART_CATALOG_GATEWAY`, `CART_INVENTORY_GATEWAY`,
`CART_EVENTS_PUBLISHER`, `OCC_RETRY_ATTEMPTS`.

**retail** `modules/orders/` (ADR-028/031/032/036) — the immutable checkout side.
**Five sibling aggregates:** `Order` (owns `OrderLine`), polymorphic `Address`
(`ownerType ∈ {customer, order}`), `Payment`, `Fulfillment` (owns `FulfillmentLine`),
`Refund`. One throwable for all of them: `OrderDomainException` + `OrderErrorCodeEnum`.
Ports: `ORDER_REPOSITORY`, `ADDRESS_REPOSITORY`, `PAYMENT_REPOSITORY`,
`FULFILLMENT_REPOSITORY`, `REFUND_REPOSITORY`, `PAYMENT_GATEWAY` (`authorize`/`capture`/`refund`,
no transport import — bound to `FakePaymentGatewayAdapter`), `TRANSACTION_PORT`,
`ORDER_CART_READER` (raw SQL over the cart tables), `ORDER_CATALOG_GATEWAY`,
`ORDER_INVENTORY_GATEWAY`, `ORDER_COMMIT_SALE_GATEWAY`, `ORDER_EVENTS_PUBLISHER`,
`ORDER_CUSTOMER_CONTACT_READER`, `AUDIT_LOG_PUBLISHER` (reused from `libs/contracts/auth`),
`IDEMPOTENCY_STORE`, `IDEMPOTENCY_KEY_TTL_HOURS`, `OCC_RETRY_ATTEMPTS`.

**retail** `modules/returns/` (ADR-032) — the RMA bounded context (a separate module, not a
sibling in `orders/`).
`ReturnRequest extends AggregateRoot<number|null>` owns `ReturnLine`. `customerId` is the
gateway's **`CHAR(36)` UUID** (not a BIGINT, despite `orderId`/`orderLineId` being BIGINTs).
`ReturnDomainException` + `ReturnErrorCodeEnum`.
Ports: `RETURN_REQUEST_REPOSITORY`, `RETURN_ORDER_READER` (raw SQL over `order` /
`order_line` / `fulfillment` — never imports `orders/`), `RETURN_EVENTS_PUBLISHER`,
`INVENTORY_RESTOCK_GATEWAY`, `RETURN_CUSTOMER_CONTACT_READER`, `TRANSACTION_PORT`,
`RETURN_WINDOW_DAYS`, `OCC_RETRY_ATTEMPTS`.
It keeps a **local copy** of `retry-then-log-for-replay.ts` — returns may not import `orders/`.

**notification** `modules/notifications/` (ADR-011/033/037) — RMQ-only.
Domain: `Notification` VO, `NotificationTemplate`, `NotificationDelivery`,
`NotificationDomainException` + `NotificationErrorCodeEnum`.
Ports: `NOTIFIER` (`LogNotifierAdapter` by default; `FlakyLogNotifierAdapter` when
`NOTIFIER_TEST_FLAKY`), `TEMPLATE_RENDERER` (`HandlebarsTemplateRendererAdapter` — the only
`handlebars` import), `NOTIFICATION_TEMPLATE_REPOSITORY`, `NOTIFICATION_DELIVERY_REPOSITORY`,
`NOTIFICATION_EVENTS_PUBLISHER`, `CONSENT_READER` (raw SELECT over the shared
`consent_record`), `CONSENT_CACHE`, `MAX_DELIVERY_ATTEMPTS`, `OPS_NOTIFICATIONS_EMAIL`,
`CONSENT_CACHE_TTL_SECONDS`.
`RenderAndDispatchUseCase` is the single persist-then-send pipeline every consumer calls.

**event-store** `modules/audit-and-events/` (ADR-034/035/039/042) — RMQ-only, no HTTP,
**its own** DB `ris_eventstore` via `DatabaseModule.forRootWithUrl` (`EVENTSTORE_DATABASE_URL`).
**One** bounded context = **one** module (ADR-042); the two append-only logs (`domain_event`,
`audit_log_entry`) are two aggregates in it, one repository port each.
Domain: `DomainEvent` and `AuditLogEntry` are **frozen value objects**, not `AggregateRoot`s;
an invariant violation throws a plain `Error`. `AuditActorType` is domain-local, not a
`libs/contracts` enum.
Ports: `DOMAIN_EVENT_REPOSITORY` and `AUDIT_LOG_REPOSITORY`, mirror surfaces — `append` +
`query` + `listByCorrelationId` (the unpaginated ascending trace read) each.
**`append` is the only mutating verb on either log**; both repositories are the sole
`@InjectRepository` sites. `application/ports` may not import `lib-common`, hence its local
`{ page, size }` shapes.
No `*DomainException` / `*RpcExceptionFilter` pair, on purpose (ADR-039).
`main.ts` is the repo's only hybrid boot (see Landmines).

## Shared Libraries

The per-library API tables are in [`README.md` §3](README.md#3-repository-layout) — not
duplicated here. Path aliases `@retail-inventory-system/<name>` (`tsconfig.json`).

What the map must carry that README does not:

- **`ddd` and `contracts` are framework-free.** No `@nestjs/*`, no TypeORM. `ddd` also holds the
  shared transaction seam (`ITransactionPort` / `TRANSACTION_PORT`, ADR-043) — it is there and
  not in `database` because `application/ports` may import only `lib-ddd` / `lib-contracts`.
- **`common/concurrency/`** holds `OCC_RETRY_ATTEMPTS` **and** `runWithOccRetry` — the one OCC
  retry protocol (ADR-045); a module's `*-write.ts` only binds to it.
- **`observability/tracer` and `observability/testing` are deep-import paths** with their own
  `tsconfig` aliases. `main.ts` must import the tracer first (see Landmines). Do not move them.
- **`CacheModule` is `@Global()`** — register once at the app root.
- `contracts` is the only lib allowed `class-validator` / `class-transformer` /
  `@nestjs/swagger` (ADR-017 §4) — every `*View` is a **class**, never an `interface`.

**Cache keys** live in `libs/cache/cache-keys.ts`. `INVENTORY_STOCK_KEY_VERSION` is `v3`; the
rest are `v1`. Consumed builders: `inventoryStock(...)`, `notificationsConsent(customerId)`. The
`catalogPrice`, `catalogCategory*`, `catalogProduct*`, `retailOrder`, `notificationsTemplate*`
builders are **reserved** (no caller).

## Conventions & boundaries (authoritative — ADR-017)

The per-layer / per-lib import constraints plus cross-service and cross-module isolation are
enforced by `eslint-plugin-boundaries` in `eslint.config.mjs`; the bumper is
`spec/architecture-lint.spec.ts` (a fixture per rule). `no-unknown-files` is `error`: a new
file that matches no element pattern fails lint — put it where the taxonomy already reaches.

**Forbidden imports.** Domain code (`apps/*/src/.../domain/` and `libs/ddd`) MUST NOT import
`@retail-inventory-system/{messaging,cache,observability,database}` or any `@nestjs/*`.
Reach those via ports. The `application-use-case` denylist forbids both `@nestjs/typeorm`
and bare `typeorm`.

**Cross-module imports** are rejected through a module's `index.ts` barrel exactly as through a
deep path (ADR-041). The sole exception is the gateway `auth` barrel, typed
`shared-module-barrel`, which `iam` / `customer-admin` consume by design (ADR-024).

**Recurring patterns.** The five in [`README.md`
§3](README.md#3-repository-layout), plus: a port is named after the **consuming** module when
two modules need the same seam (`ORDER_INVENTORY_GATEWAY` vs `CART_INVENTORY_GATEWAY`).

**Cache-key convention** (ADR-016 + ADR-022). Apps under `apps/*/src` MUST NOT write cache-key
string literals (call a `CACHE_KEYS` builder) and MUST NOT import `@nestjs/cache-manager` /
`@keyv/redis` / `cacheable` directly (depend on `ICachePort` / `CACHE_PORT`). Write paths
invalidate via `CACHE_KEYS.<aggregate>Prefix` + `delByPrefix`, awaited post-commit. On stock
this is type-enforced (ADR-023/049): `IStockCachePort` offers **only** the two composed
operations — `getOrLoad(payload, loader)` and `withInvalidation(work, resolveItems, opts)`.
No `invalidate`, and no raw `get`/`set` either: a pre-commit `set` is as permanently stale as
a pre-commit invalidate, so both are private to `StockCache`.

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

## Architecture decisions (ADRs)

Rules and target state live as ADRs under [`docs/adr/`](docs/adr/) — see
[`docs/adr/index.md`](docs/adr/index.md). Write one per architectural decision, under ADR-003's
rules. **Next free number is `051`.** On a feature branch an ADR is still a draft.

Per-capability walkthroughs live under [`docs/implementation/`](docs/implementation/),
numbered by delivery order. Point-in-time review findings live under
[`docs/audits/`](docs/audits/).

**One architectural exception: `ARCH-LINT-EX-02`** (ADR-017 §6) — the gateway `auth` barrel is
the sole cross-module-consumable barrel (`iam` / `customer-admin`).

**The `EntityManager` downcast is an `infrastructure/` idiom, not a two-file exception.** Every
repository that accepts an `ITransactionScope` casts it back to use it (11 files, `orders/`,
`returns/`, `stock/`) — that is what an opaque scope costs. The rule ARCH-LINT-EX-01's closure
actually bought is the one to keep: **`EntityManager` never reaches `application/`**, which the
`application-use-case` denylist enforces. *(ADR-017 §6 names only `TypeormTransactionAdapter` +
`StockTypeormRepository`; that was true when it was written and the idiom has since generalised. An
accepted ADR is immutable — this needs a forward-supersession pointer, not an edit.)*
