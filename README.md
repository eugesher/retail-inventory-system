# Retail Inventory System

A microservices retail commerce API — catalog, pricing, inventory, checkout, fulfillment,
returns, refunds, notifications, and an append-only event store — built with **NestJS**,
**RabbitMQ**, **MySQL**, and **Redis**.

Six deployables talk over RabbitMQ behind a single HTTP gateway. Every service is a
per-module hexagon (`domain` → `application` → `infrastructure` / `presentation`) whose
boundaries are enforced by `eslint-plugin-boundaries`, not by convention.

The durable design record is this file plus the ADRs under [`docs/adr/`](docs/adr/) —
start at [`docs/adr/index.md`](docs/adr/index.md).

---

## Table of contents

1. [Quick start](#1-quick-start)
2. [Architecture at a glance](#2-architecture-at-a-glance)
3. [Repository layout](#3-repository-layout)
4. [Bounded contexts](#4-bounded-contexts)
5. [Cross-cutting guarantees](#5-cross-cutting-guarantees)
6. [HTTP API](#6-http-api)
7. [Authentication and authorization](#7-authentication-and-authorization)
8. [Configuration](#8-configuration)
9. [Development workflow](#9-development-workflow)
10. [Seed data](#10-seed-data)
11. [Observability](#11-observability)
12. [Caching](#12-caching)
13. [Background jobs](#13-background-jobs)
14. [Not built yet](#14-not-built-yet)
15. [Documentation map](#15-documentation-map)

---

## 1. Quick start

### Prerequisites

Node 20+, Yarn, Docker Compose.

### Run it

```bash
cp .env.example .env.local          # host-side defaults for `yarn start:dev`

docker compose up -d mysql redis rabbitmq

yarn migration:run                  # retail_db      (operational schema)
yarn migration:run:eventstore       # ris_eventstore (isolated event-store schema)
yarn test:seed                      # deterministic fixtures — users, catalog, stock, templates

yarn start:dev                      # all six services, watch mode
```

`ris_eventstore` is created once per fresh MySQL volume by
`scripts/mysql-init/01-create-eventstore-db.sql`. Both migration pipelines keep separate
`migrations` ledgers — see [ADR-034](docs/adr/034-isolated-eventstore-database.md).

### Talk to it

| What | Where |
| --- | --- |
| HTTP API | `http://localhost:3000/api` |
| Interactive API reference | `http://localhost:3000/api/reference` |
| Request collections | [`http/kulala/`](http/kulala/) (Kulala) and [`http/posting/`](http/posting/) (posting.sh) |
| Jaeger UI (observability overlay) | `http://localhost:16686` |

### Seeded logins

`yarn test:seed` (also run by `yarn test:infra:reload`) inserts argon2id-hashed users —
four staff, one per canonical role, and one customer.

| Email | Password | Role | Subject kind |
| --- | --- | --- | --- |
| `admin@example.com` | `admin1234` | `admin` | StaffUser |
| `catalog@example.com` | `catalog1234` | `catalog-manager` | StaffUser |
| `warehouse@example.com` | `warehouse1234` | `warehouse-staff` | StaffUser |
| `support@example.com` | `support1234` | `order-support` | StaffUser |
| `customer@example.com` | `customer1234` | — | Customer |

---

## 2. Architecture at a glance

### Request flow

```
HTTP → API Gateway (auth + global guards) → RabbitMQ → Microservice → MySQL
```

The gateway holds **no business logic**. Its modules are thin RPC fronts: a port symbol,
a use case that folds the authenticated identity into the command, and one
`ClientProxy`-holding adapter. The exception is `modules/auth/`, which owns real domain
state (the identity tables).

### System diagram

```
                   ┌───────────────────────┐
                   │     Client (HTTP)     │
                   └───────────┬───────────┘
                               │
              ┌────────────────▼────────────────┐
              │    API Gateway   :3000 /api     │
              │    JwtAuthGuard → RolesGuard    │
              │       → PermissionsGuard        │
              └────────────────┬────────────────┘
                               │  RabbitMQ (RPC + events)
       ┌───────────────┬───────┴───────┬───────────────┬───────────┐
       │               │               │               │           │
┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐    │
│   retail    │ │   catalog   │ │  inventory  │ │notification │    │
│retail_queue │ │catalog_q.   │ │inventory_q. │ │notification_│    │
│             │ │  + pricing  │ │             │ │   events    │    │
│cart · orders│ │products     │ │stock levels │ │templates    │    │
│fulfillment  │ │variants     │ │reservations │ │deliveries   │    │
│returns      │ │categories   │ │movements    │ │consent gate │    │
│refunds      │ │media        │ │             │ │             │    │
└──────┬──────┘ └──────┬──────┘ └──┬───────┬──┘ └──┬───────┬──┘    │
       │               │           │       │       │       │       │
       │               │           │    ┌──▼───────▼──┐    │       │
       │               │           │    │    Redis    │    │       │
       │               │           │    │stock keys   │    │       │
       │               │           │    │consent keys │    │       │
       │               │           │    └─────────────┘    │       │
       └───────────────┴───────┬───┴───────────────────────┘       │
                               │                                   │
                   ┌───────────▼───────────┐                       │
                   │   MySQL: retail_db    │                       │
                   │    (shared schema)    │                       │
                   └───────────────────────┘                       │
                                                                   │
   every producer ALSO mirrors its event onto the                  │
   topic exchange `ris.events` (dual-publish,                      │
   best-effort) — the event store binds `#`                        │
                                                                   │
                               ┌───────────────────────────────────┘
                               │  event_store_firehose_queue  (ingest, topic exchange)
             ┌─────────────────▼─────────────────┐
             │    event-store microservice       │◀── event_store_query_queue
             │  MySQL: ris_eventstore            │    (audit.* RPCs, default exchange)
             │  domain_event · audit_log_entry   │
             └───────────────────────────────────┘
```

The gateway's own `auth` tables live in `retail_db` too — that edge is omitted above for
legibility. Redis is used by **inventory** (stock availability) and **notification**
(consent) only, both cache-aside.

### Deployables

| Service | Transport | Responsibility |
| --- | --- | --- |
| `api-gateway` | HTTP `:3000` | Single entry point; JWT + RBAC; owns the identity tables (`auth`) and two admin shells (`iam`, `customer-admin`) |
| `catalog-microservice` | RMQ `catalog_queue` | `Product` / `ProductVariant`, `Category` tree, polymorphic `MediaAsset`, plus the colocated **pricing** module (`Price` ledger, `TaxCategory`) |
| `inventory-microservice` | RMQ `inventory_queue` | `StockLevel` running totals, `StockLocation`, TTL `Reservation` holds, append-only `StockMovement` ledger |
| `retail-microservice` | RMQ `retail_queue` | Checkout — mutable `Cart`; immutable `Order` + `OrderLine` + `Address` + `Payment` + `Fulfillment` + `Refund`; the `ReturnRequest` RMA context |
| `notification-microservice` | RMQ `notification_events` | Versioned templates, delivery audit trail, render-and-dispatch pipeline, consent gate, retry sweeper |
| `event-store-microservice` | RMQ `event_store_firehose_queue` + `event_store_query_queue` | Append-only sink: `domain_event` (event firehose) + `audit_log_entry` (staff audit log), in its **own** database; answers the three `audit.*` query RPCs |

### Two logical databases

| Database | Owner | Contents |
| --- | --- | --- |
| `retail_db` | every operational context | identity, catalog, pricing, inventory, cart, orders, fulfillment, returns, refunds, idempotency keys, notification templates + deliveries |
| `ris_eventstore` | event store only | `domain_event`, `audit_log_entry` — append-only, high volume, independently truncatable ([ADR-034](docs/adr/034-isolated-eventstore-database.md)) |

Entities live beside the bounded context that owns them; the shared `retail_db` is a
deliberate monolith-of-schema with foreign keys across contexts (`cart.customer_id`,
`*_line.variant_id`, `order.source_cart_id`, …).

### Eventing

Wire format is dotted `<service>.<aggregate>.<action>` ([ADR-008](docs/adr/008-rabbitmq-via-libs-messaging.md)).

**Producer targets the consumer's queue.** An event is emitted onto the *consumer's*
queue, not the producer's — catalog emits `catalog.variant.created` onto `inventory_queue`;
retail emits customer-facing events onto `notification_events`. Events with no consumer sit
on the producer's own queue as reserved surfaces.

**Every producer dual-publishes** ([ADR-035](docs/adr/035-event-store-firehose-topic-exchange.md)).
Beside the primary `emit`, each publisher mirrors the same routing key + payload onto the
durable topic exchange `ris.events` via the shared `RisEventsMirrorPublisher`. The mirror is
**non-throwing best-effort** and ordered *after* the primary emit, so a `ris.events` outage can
never shadow the publish that feeds a real consumer. The event store binds a single queue to
`ris.events` with the catch-all `#` and dispatches inside the consumer — no existing consumer
was re-bound. Its second queue, `event_store_query_queue`, carries RPCs on the default
exchange and is not bound to this exchange at all.

> The binding pattern is a lone `#`, **not** `#.#`. RabbitMQ routes both, but Nest's
> `matchRmqPattern` rejects `#.#` for any multi-word routing key and nacks the message.

| Event | Consumer |
| --- | --- |
| `catalog.variant.created` | inventory — auto-init a zeroed `StockLevel` |
| `inventory.stock.low` | notification — ops alert to `OPS_NOTIFICATIONS_EMAIL` |
| `retail.order.placed` | notification |
| `retail.order.cancelled` | **dual-emitted** — retail (auto-refund) *and* notification |
| `retail.fulfillment.shipped` / `.delivered` | notification |
| `retail.return.requested` / `.authorized` / `.received` / `.inspected` | notification |
| `retail.refund.issued` | notification |
| `customer.consent.updated` / `customer.erased` | notification — consent-cache write-through / evict |
| `audit.staff.action` | event store → `audit_log_entry` |
| *everything else on `ris.events`* | event store → `domain_event` |

**Reserved surfaces** (published, captured by the firehose, no business consumer):
`catalog.product.*`, `catalog.price.*`, `inventory.stock-level.initialized`,
`inventory.stock.{received,adjusted,reserved,allocated,released,committed,returned}`,
`inventory.stock-movement.recorded`, `retail.cart.*`,
`retail.payment.{authorized,captured}`, `retail.fulfillment.created`,
`retail.refund.failed`, `retail.return.{rejected,closed}`, `notifications.delivery.failed`.

**Delivery guarantee.** The bus is at-least-once and dual-publish has no transactional
outbox, so the firehose may see an event twice. `domain_event` absorbs the redelivery on a
composite UNIQUE (the idempotent-consumer pattern); `audit_log_entry` intentionally keeps
every occurrence.

---

## 3. Repository layout

```
apps/
  api-gateway/                # HTTP entry point (:3000)
  catalog-microservice/       # modules/catalog/ + modules/pricing/
  inventory-microservice/     # modules/stock/
  retail-microservice/        # modules/cart/ + modules/orders/ + modules/returns/
  notification-microservice/  # modules/notifications/
  event-store-microservice/   # modules/audit-and-events/
libs/
  auth/           # AuthModule.forRootAsync, guards, @Public/@Roles/@RequiresPermission/@CurrentUser
  cache/          # ICachePort + RedisCacheAdapter + @Cacheable + CACHE_KEYS registry
  common/         # framework-free: Result, DomainException, pagination, bodyFingerprint
  config/         # configModuleConfig (Joi env schema)
  contracts/      # cross-service message + DTO contracts (plain TypeScript)
  database/       # BaseEntity, BaseTypeormRepository, TypeormTransactionAdapter, DatabaseModule
  ddd/            # Entity, AggregateRoot, ValueObject, DomainEvent, IRepositoryPort, ITransactionPort
  messaging/      # per-service client modules, RabbitmqClientFactory, RisEventsMirrorPublisher, ROUTING_KEYS
  observability/  # Pino config, CorrelationMiddleware, OTel tracer.ts, MetricsModule
docs/adr/            # architecture decision records — the durable rationale
docs/implementation/ # per-capability walkthroughs, numbered by delivery order
migrations/          # retail_db migrations + migrations/eventstore/
http/                # Kulala + posting.sh request collections
test/                # e2e suites (gateway HTTP in, public state out)
spec/                # architecture-lint regression fixtures
```

### Shared libraries

Imported via path aliases as `@retail-inventory-system/<name>`.

| Library | What it gives you |
| --- | --- |
| `contracts` | Wire contracts — `microservices/`, `auth/`, `audit/`, `retail/`, `inventory/`, `catalog/`, `notifications/`. Plain TypeScript; class-validator / Swagger decorators are the documented exception for DTOs. |
| `ddd` | `Entity<TId>`, `AggregateRoot<TId>` (`pullDomainEvents()`), `ValueObject`, `DomainEvent`, `IRepositoryPort`. **No `@nestjs/*`, no TypeORM.** |
| `common` | `Result`, `DomainException`, `IPage` / `IPageRequest`, `Maybe` / `Nullable`, `bodyFingerprint` (request digest), `OCC_RETRY_ATTEMPTS` (the shared OCC retry-budget token). |
| `database` | `BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy`, `DatabaseModule.forRoot(entities)` / `.forFeature(...)` / `.forRootWithUrl(entities, urlEnvVar)`. |
| `messaging` | Per-service client modules + `MicroserviceClientRisEventsModule`, `RabbitmqClientFactory`, `RisEventsMirrorPublisher`, `ROUTING_KEYS`, `EXCHANGES`. |
| `cache` | `ICachePort` (`get`/`set`/`del`/`wrap`/`delByPrefix`/`singleFlight`), `CACHE_PORT`, `RedisCacheAdapter` (OTel-spanned), global `CacheModule`, `@Cacheable()`, `CACHE_KEYS`. |
| `observability` | `LoggerModuleConfig` (Pino + trace correlation), `CorrelationMiddleware`, `@CorrelationId()`, OTel `tracer.ts` side-effect bootstrap. |
| `auth` | `AuthModule.forRootAsync()`, `JwtStrategy`, the three guards, `@Public()` / `@Roles()` / `@RequiresPermission()` / `@CurrentUser()`. Re-exports `RoleEnum`. |
| `config` | `configModuleConfig` — the Joi env schema. |

### The per-module hexagon

Every module in every service has the same four layers. The notification microservice is
the canonical template ([ADR-011](docs/adr/011-notifier-port-and-adapters.md)).

```
modules/notifications/
├── notifications.module.ts  # the composition root — wires all four layers below (ADR-041)
├── index.ts                 # the module's public barrel — the only way in from outside
├── domain/            # aggregates, value objects, error codes — framework-free
├── application/
│   ├── ports/         # interfaces + DI symbols (NOTIFIER, TEMPLATE_RENDERER, CONSENT_CACHE…)
│   └── use-cases/     # one file per operation; depends only on ports + domain
├── infrastructure/    # TypeORM repositories, RMQ publishers/consumers, Redis cache,
│                      #   Handlebars renderer, schedulers — the only ClientProxy site
└── presentation/      # @MessagePattern handlers + the RPC exception filter
```

The `@Module` file sits **beside** the hexagon, never inside a layer of it: binding the ports to
the adapters and the controllers to the use cases means it must see all four at once, so it
belongs to none of them ([ADR-041](docs/adr/041-nest-module-as-the-module-composition-root.md)).

**Boundary rule.** `ClientProxy` from `@nestjs/microservices` is allowed *only* inside
`infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`. Controllers, use cases, and
pipes inject the port symbol instead.

### Architecture lint

The layering plus cross-service and cross-module isolation are enforced by
`eslint-plugin-boundaries` in `eslint.config.mjs` ([ADR-017](docs/adr/017-architecture-lint-via-eslint-boundaries.md)).
**`yarn lint` is the source of truth for where a file belongs. Do not weaken a rule to make code pass.**

- `domain/` may import only `libs/ddd`, `libs/common`, `libs/contracts`. No `@nestjs/*`,
  no TypeORM, no Redis, no AMQP, no logging.
- `application/use-cases/` may import its own module's `domain` + `application/ports` and
  the same lib set, plus `libs/auth` for port interfaces. Both `@nestjs/typeorm` and bare
  `typeorm` are denied.
- `application/ports/` may import only `domain` types and `libs/contracts`.
- `infrastructure/` is the only layer allowed to touch concrete adapters.
- `presentation/` may import `application` + `libs/{auth,contracts,messaging,observability}`.
- `<m>.module.ts` and the module-root `index.ts` are the `nest-module` element: they see every
  layer of their **own** module and nothing of a sibling's.
- Every file under `apps/` and `libs/` must claim an element type (`boundaries/no-unknown-files`).
  A file the taxonomy cannot place is a file no other rule can govern.
- Cross-service (`apps/X` → `apps/Y`) and cross-module imports are rejected outright — through a
  module's barrel just as much as through a deep path. The **one** exception is the gateway
  `auth` barrel, which the `iam` and `customer-admin` admin shells consume by design (ADR-024;
  encoded as the `shared-module-barrel` element type, ADR-017 §6).

Each rule has a fixture in [`spec/architecture-lint.spec.ts`](spec/architecture-lint.spec.ts)
that intentionally violates it and asserts the expected `boundaries/*` ruleId fires — so
silently weakening a rule fails the unit suite.

### Recurring patterns

- **One throwable per module** — `*DomainException` + `*ErrorCodeEnum`, mapped to HTTP by
  that module's presentation `*RpcExceptionFilter`. The filters are the authoritative
  code → status tables.
- **One repository port per aggregate seam** — not one god-repository per module.
- **Cross-module reads via a raw-parameterized-SQL reader port** rather than importing the
  other module's entities (`ORDER_CART_READER`, `RETURN_ORDER_READER`, `CONSENT_READER`).
- **A gateway adapter wraps a rejection in `RpcException(err)`** so the upstream typed
  `{ code, details }` reaches the HTTP client verbatim.
- **A human-facing number** (`order_number`, `rma_number`) is finalized from the generated
  id via the "re-read then finalize a derived field" idiom.

---

## 4. Bounded contexts

### Catalog and pricing (`catalog-microservice`)

`Product` (`draft → active → archived`) owns `ProductVariant` children.
**`variantId` is the downstream backbone key, not `productId`** — inventory stock levels,
prices, and cart/order lines all address a concrete variant, the unit that is stocked,
priced, and sold.

`Category` is a hierarchy on a **materialized `path`** (`/electronics/phones`):
a subtree read is one indexed `path LIKE`, an ancestry test a string-prefix check.
Reparenting recomputes the moved node and rebases every descendant's path in one bulk
`UPDATE`; a cycle is rejected in the domain. An archived intermediate hides its branch.

`MediaAsset` is **polymorphic** over `(owner_type, owner_id)` — one table, images/videos/
documents on a product *or* a variant, **no FK** on the polymorphic owner (the attach use
case probes existence by hand; a composite `(owner_type, owner_id, sort_order)` index is
the read-path compensation). `uri` is an opaque, already-uploaded reference. Detach is a
state-guarded `active → archived` flip; the row survives.

`product_categories` is a **bare N↔M join** — composite PK, no surrogate id, no entity;
maintained with parameterized `INSERT IGNORE` / `DELETE` in the repository. Neither
category nor media operations emit events.

**Two publish preconditions, deliberately asymmetric:**

| Precondition | Behaviour |
| --- | --- |
| Every variant has an in-effect price in `DEFAULT_CURRENCY` | **Hard** — `409 PRODUCT_PUBLISH_REQUIRES_PRICE`. A price-less product breaks checkout. |
| Some owner has an active `MediaAsset` | **Soft** — publish proceeds, `ProductView.warnings[]` carries `CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA`. A media-less product only looks bare. |

The colocated **`pricing`** module is *not* a separate deployable — a price attaches to a
`variantId` and shares `catalog_queue`. `price` is an append-only-for-history,
`(variantId, currency)`-scoped, time-bounded ledger: a change appends a row and closes the
predecessor's `[validFrom, validTo)` interval, with at most one open row per scope
(app close-in-transaction plus a generated-column UNIQUE backstop). `tax_category` is a
classification **label only** — rates and jurisdictions are out of scope.
`catalog.price.set` is one command for both Set and Schedule, distinguished by `validFrom`;
`catalog.price.select` resolves `(variantId, currency, asOf)` to a single price,
priority DESC then `validFrom` DESC.

ADRs: [025](docs/adr/025-catalog-product-and-variant-aggregate.md),
[026](docs/adr/026-price-append-only-ledger-and-tax-category.md),
[029](docs/adr/029-category-materialized-path-and-polymorphic-media.md).

### Inventory (`inventory-microservice`)

Three aggregates plus one append-only ledger record, all keyed on the opaque catalog
`variantId`.

| Aggregate | Shape |
| --- | --- |
| `StockLevel` | Per-`(variantId, stockLocationId)` running totals: `quantityOnHand`, `quantityAllocated`, `quantityReserved`. `available = onHand − allocated − reserved` is a **pure getter**. A `version` column carries OCC. |
| `StockLocation` | Caller-assigned string PK, `StockLocationTypeEnum`, `active` flag. The migration auto-provisions `default-warehouse`. |
| `Reservation` | TTL-bounded, cart-scoped hold. App-generated `CHAR(36)` UUID. `active → committed / released / expired`, plus a `reactivate` row-reuse path so the all-statuses UNIQUE `(cartId, variantId, stockLocationId)` triple survives a remove-then-re-add. |
| `StockMovement` | Immutable, `Object.freeze`d ledger record — no mutators, no events. Six types with a **fixed sign**: `+` receipt/return, `−` sale/allocation/release, `±` non-zero adjustment. Polymorphic FK-less `referenceType`/`referenceId`. |

Every counter-changing operation appends a `StockMovement` **in the same transaction** and
routes through `stockCache.withInvalidation(...)` (post-commit invalidation,
[ADR-023](docs/adr/023-cache-invalidate-post-commit-by-type.md)) and the shared bounded-OCC
`runWithStockWriteRetry`.

| RPC | Use case | Notes |
| --- | --- | --- |
| `inventory.stock-level.get` | `QueryAvailabilityUseCase` | cache-aside, per variant |
| `inventory.location.list` | `ListLocationsUseCase` | uncached |
| `inventory.stock-movement.list` | `ListStockMovementsUseCase` | paginated, newest-first, uncached audit read |
| `inventory.stock-level.receive` | `ReceiveStockUseCase` | positive `receipt` movement |
| `inventory.stock-level.adjust` | `AdjustStockUseCase` | signed delta + `reasonCode`; below-zero → `409`; re-fires `inventory.stock.low` |
| `inventory.stock-level.transfer` | `TransferStockUseCase` | atomic two-location on-hand move — two `StockLevel` writes + a paired `transfer-out`/`transfer-in` `adjustment` movement |
| `inventory.reservation.reserve` | `ReserveStockUseCase` | no-oversell guard; idempotent by *absolute* quantity on the triple; `expiresAt = now + RESERVATION_TTL_MINUTES` |
| `inventory.reservation.release` | `ReleaseReservationUseCase` | selector is `reservationId` **or** `cartId` (+ optional facets); both/neither → `400` |
| `inventory.reservation.sweep` | `SweepExpiredReservationsUseCase` | the on-demand twin of the sweep timer — same use case, plus a staff `actorId` on every ledger row; `batchSize` clamped to `RESERVATION_SWEEP_BATCH_SIZE` |
| `inventory.reservation.allocate` | `AllocateStockUseCase` | cart holds → order allocation at place-time; per line refresh-then-commit, drift-rebalance, or `allocateDirect` fallback; all-lines-atomic |
| `inventory.allocation.cancel` | `CancelAllocationUseCase` | reverses an order's allocation; touches no reservation rows |
| `inventory.stock.commit-sale` | `CommitSaleUseCase` | ship-from-allocated; **idempotency-first on `fulfillmentId`**; decrements on-hand **and** allocated |
| `inventory.stock.restock-from-return` | `RestockFromReturnUseCase` | **idempotency-first on `returnRequestId`**; raises on-hand only, so no low-stock re-fire |

The reserve / allocate / cancel-allocation / commit-sale / restock RPCs have **no gateway HTTP
route** — they are driven retail → inventory. `CatalogEventsConsumer` handles
`catalog.variant.created` → `AutoInitStockLevelUseCase`.

ADRs: [027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md),
[030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md),
[031](docs/adr/031-fulfillment-aggregate-and-ship-triggered-capture.md),
[032](docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md).

### Retail — cart (`retail-microservice`, `modules/cart/`)

The **mutable** side of checkout. `Cart` (in-app `CHAR(36)` UUID) owns `CartLine`;
status is `active → converted` or `active → abandoned`, both terminal — a non-`active`
cart is frozen. `addLine` increments an existing line rather than duplicating it,
`changeLineQuantity` rejects `0`, and every mutator bumps `version` and records a
framework-free domain event.

A `CartLine` **snapshots** its unit price (minor units) and currency at add-time, so a
sibling line's change never re-prices it.

Six RPCs, each re-asserting `cart.customerId === payload.customerId` (`403` on mismatch):

| RPC | Inventory side effect |
| --- | --- |
| `retail.cart.create` / `.get` | none |
| `retail.cart.add-line` | snapshots price via `catalog.price.select` (unpriced → `409`); **reserves the line's absolute target quantity before save** |
| `retail.cart.change-line-quantity` | re-reserves the absolute new quantity before save |
| `retail.cart.remove-line` | releases the hold **after** save, best-effort |
| `retail.cart.claim` | none — a hold keys on `cartId`, and a claim only re-points the owner |

Out of stock is `409 { code: 'INVENTORY_OUT_OF_STOCK', details: { available } }`
end-to-end, and the cart is never mutated.

**Guest carts.** `POST /api/auth/customer/guest-session` mints a real `status='guest'`
Customer with a null password and a customer-tier token — the guest token replaces a
session cookie, so a guest builds a cart through the same bearer-protected routes.
`POST /api/cart/:cartId/claim` then promotes it, re-pointing the cart only if the supplied
`fromCustomerId` (the ownership proof) matches its current owner.

### Retail — orders, payment, fulfillment, refunds (`modules/orders/`)

The **immutable** side. Five sibling aggregates live here.

| Aggregate | Id | Why it lives here |
| --- | --- | --- |
| `Order` + `OrderLine` | `BIGINT` | the root |
| `Address` | `CHAR(36)` | polymorphic over `ownerType ∈ {customer, order}`; an order's addresses are immutable **snapshot copies**, never references into a customer address book |
| `Payment` | `BIGINT` | its operations mutate `Order` |
| `Fulfillment` + `FulfillmentLine` | `BIGINT` | per-shipment, per-location |
| `Refund` | `BIGINT` | a refund mutates `Payment` — and a refund can exist with **no** return behind it (a chargeback, a goodwill credit, a cancel-before-ship) |

**An `Order` carries three orthogonal status axes**, not one combined enum, because a
`captured` payment legitimately coexists with `unfulfilled` fulfillment:

| Axis | Values |
| --- | --- |
| `status` | `pending` → `confirmed` / `cancelled` / `shipped` / `delivered` |
| `paymentStatus` | `none` → `authorized` → `captured` → `refunded` (or `failed`) |
| `fulfillmentStatus` | `unfulfilled` → `partially-shipped` → `shipped` → `delivered` |

`Fulfillment.status` (`pending → shipped → delivered`, or `cancelled`) is a **fourth axis**,
evolving per shipment; the order's `fulfillmentStatus` is the roll-up. Partial and split
shipments are simply multiple `Fulfillment`s per order. Fulfillments are append-only —
cancellation is a status flip, and a `shipped`/`delivered` one is never cancellable, which
is what protects Cancel Order.

`order_number` is `ORD-<year>-<pad8(id)>`, `order.source_cart_id` links the converted cart,
and `order.customer_id` is **nullable** so an erased customer leaves a tombstone.

**Place Order** converts an `active` cart one-shot: snapshot lines from
`catalog.variant.get` + `catalog.price.select`, snapshot both addresses, `markConverted`,
**allocate the cart's holds inside the same transaction** — an unallocatable line rolls the
whole place back (`409 INVENTORY_OUT_OF_STOCK`, no order row, cart stays `active`), and a
rare post-allocate commit failure fires a best-effort `inventory.allocation.cancel`
compensation. Payment is authorized inline afterwards, in a short follow-up transaction —
so money is never authorized for unallocatable stock.

**Ship Fulfillment** is the pivot that moves stock and money together:

1. Preconditions — the fulfillment exists, belongs to the order, is `pending`, has a tracking number.
2. **Ship-triggered capture (Q5):** an `authorized` payment is captured through
   `PAYMENT_GATEWAY` **before** the local commit. A decline **blocks the ship**
   (`409 ORDER_PAYMENT_NOT_CAPTURED`) — nothing is written, no saga, no
   `pending-with-payment-failure` state.
3. One transaction: `Fulfillment → shipped`, record the capture, flip each shipped
   `OrderLine.status`, advance the order's roll-up `fulfillmentStatus`.
4. **After** commit: cross-service `inventory.stock.commit-sale` — retried, then logged for
   replay. The local ship is **never** rolled back; commit-sale's `fulfillmentId`
   idempotency makes the replay safe.

**Cancel Order** is refused once any fulfillment is `shipped`/`delivered`
(`409 ORDER_NOT_CANCELLABLE` — the lifecycle axis stays `pending` after a ship, so this
fulfillment-presence check, not the lifecycle guard, is the real shipped-stock guard).
When allowed it cancels the order and its `pending` fulfillments, settles the payment —
an `authorized` payment is **voided**, a `captured` one is **flagged for refund** — and,
after commit, releases the allocation. It emits `retail.order.cancelled` carrying
`paymentFlaggedForRefund`.

**Auto-refund from cancel.** `OrderCancelledConsumer` subscribes to retail's *own* cancel
event on `retail_queue` and, when the payment was flagged, inline-calls `IssueRefundUseCase`
for the still-refundable remainder with `reason: 'order-cancelled'`, a `null` (system) actor,
and a **deterministic** idempotency key `order-cancelled:<orderId>:<paymentId>` — so a
redelivered cancel collapses to a store replay. A downstream failure is warn-logged and
swallowed, leaving `flagged_for_refund` set as the durable manual-retry anchor.

**Cancel Line** (staff only) cancels a single line's **unshipped** quantity and releases
just that slice of the allocation. The count is recorded on `order_line.cancelled_quantity`
(ADR-040), so `quantity − cancelled_quantity` is the line's **active** quantity — the bound
Cancel Line, Create Fulfillment, Ship's roll-up, and the returnable pool all measure
against. The write is a version-checked CAS and commits **before** the release, so the same
units can never be cancelled (and released) twice. No money-total change, no event.

**Issue Refund** enforces the refundable ceiling (`amount ≤ amount_minor − refunded_amount_minor`),
calls the gateway **outside** the transaction, then runs `Payment.refund` +
`Refund.markIssued` in one short transaction, and **always audits** the money movement.
`Payment.refund` accumulates `refunded_amount_minor` and flips `CAPTURED → REFUNDED`
(clearing the refund flag) only on a **full** refund.

#### Payment gateway

Authorize, capture, void, and refund all run behind `IPaymentGatewayPort`
(DI symbol `PAYMENT_GATEWAY`) — declared in `application/ports/`, importing no transport
package, the same shape as `NotifierPort`. The default binding is
`FakePaymentGatewayAdapter`: an in-process stand-in that **always approves** and mints
deterministic `fake_<uuid>` / `fake_refund_<uuid>` references.

Swapping in Stripe/Adyen is a **single provider rebind** in `orders.module.ts` plus a new
HTTP-doing sibling adapter under `infrastructure/payment-gateway/`. No use case, controller,
domain model, or contract changes.

#### Concurrency guards, side by side

| Contended row | Guard | Loser gets |
| --- | --- | --- |
| `fulfillment` (ship vs cancel) | pessimistic `SELECT … FOR UPDATE` re-read | its own terminal domain `409` (`FULFILLMENT_INVALID_STATUS_TRANSITION` / `ORDER_NOT_CANCELLABLE`) |
| `order` header (two ships rolling up) | version-checked CAS inside a bounded retry | `409 VERSION_MISMATCH` + `details.currentVersion` |

Both mean "you lost the race" — the **two legitimate 409s** model.

### Retail — returns / RMA (`modules/returns/`)

Its own bounded context, not a sibling in `orders/`, because the RMA lifecycle is a
substantial state machine with warehouse-facing operations.

```
requested ──► authorized ──► received ──► inspected ──► closed
    │
    └──► rejected
```

`rejected` and `closed` are terminal.

`ReturnRequest` (`BIGINT`) owns `ReturnLine`. `rmaNumber` is `RMA-<year>-<pad8(id)>`.
`customerId` is the gateway's **`CHAR(36)` UUID** (the buyer), mirroring `order.customer_id`
— *not* a BIGINT, despite `orderId`/`orderLineId` being BIGINTs. A `ReturnLine`'s
`condition` / `disposition` / `lineRefundAmountMinor` are null until inspection, then
`inspect`-once.

| Operation | Auth | Behaviour |
| --- | --- | --- |
| Open | owner-or-staff `order:return-authorize` | resolves the order via the raw-SQL `RETURN_ORDER_READER`; enforces the `RETURN_WINDOW_DAYS` window (a `delivered` order is always returnable; a `shipped` one only inside the window) and `requested ≤ ordered − cancelled − already-returned` |
| Authorize / Reject / Close | staff `order:return-authorize` | status walk; Reject appends its reason to `notes` |
| Receive | warehouse `inventory:receive-return` | status walk |
| Inspect | warehouse `inventory:receive-return` | the inspection set must cover **every** line; after commit, each `restock`-disposition line calls `inventory.stock.restock-from-return` (retry-then-log, idempotent on `returnRequestId`). Records refund amounts but **issues no refund**. |
| Get / List | owner-or-staff `order:read` | non-staff filtered to own |

### Notifications (`notification-microservice`)

RMQ-only, no HTTP surface of its own. Two aggregates in the shared `retail_db`
([ADR-033](docs/adr/033-notification-templates-deliveries-and-render-dispatch.md)):

- **`NotificationTemplate`** — a versioned registry keyed on `(eventType, channel, locale)`.
  An edit **appends** a new business `version`; old rows are retained. The newest `active`
  version wins (`findLatestActive`), so rollback is one call: deactivate the newest.
  `subject` is required for `email`/`webhook`, optional for `sms`/`push`.
- **`NotificationDelivery`** — the queryable audit trail. `queued → sent → delivered | bounced`,
  `queued | failed → failed`, `failed → sent` (retry), with a monotonic `attemptCount`. Plus
  the terminal **`skipped-no-consent`**, set at row creation by the `skipped()` factory —
  never reached through `queued`, `attemptCount = 0`.

**`RenderAndDispatchUseCase` is the single persist-then-send pipeline every consumer calls.**
Given a channel-agnostic input it resolves the latest active template, renders it, runs the
consent gate, **persists a `queued` row *before* the `NOTIFIER` call**, then flips it to
`sent` or `failed`. A failure is recorded on the row and **never rethrown** — rethrowing
inside an `@EventPattern` would make the broker blind-redeliver. A missing template
warn-logs and persists nothing.

Double-dispatch is deduped twice: an explicit `findByDedupeKey` pre-check (customer-facing
rows only) plus a STORED generated-column UNIQUE (`delivery_dedupe_key`) that collapses a
concurrent race.

**The consent gate** ([ADR-037](docs/adr/037-consent-record-and-tombstone-erasure.md)) runs
before the transport call, for customer-facing rows only (a null-recipient ops row skips it):

| Channel + event type | Gated on |
| --- | --- |
| email, `eventType ∈ TRANSACTIONAL_EVENT_TYPES` | `transactionalEmail` — **the bypass**; an order confirmation is never blocked by a marketing opt-out |
| email, anything else | `marketingEmail` |
| sms | `marketingSms` |
| push / webhook | ungated |

An unconsented channel persists a terminal `skipped-no-consent` row — an auditable
"deliberately not sent" — **before and instead of** the transport call. Consent is read
cache-aside at `ris:notifications:consent:v1:<customerId>`, kept fresh by the
`customer.consent.updated` / `customer.erased` events rather than by TTL. The cache
**fails safe**: a Redis or reader error resolves to defaults (transactional allowed,
marketing suppressed), so a dispatch never blind-redelivers.

**Seven consumers.** Six route their wire event through `RenderAndDispatchUseCase`
(`inventory-events`, `order-events`, `order-cancelled-events`, `fulfillment-events`,
`return-events`, `refund-events`); the seventh, `consent-events`, only refreshes/evicts the
consent cache. All nine customer-facing retail events carry a producer-resolved
`customerEmail?` / `customerLocale?` (resolved best-effort post-commit through a raw-SQL
customer-contact reader; `customerLocale` currently ships `null`). A row whose
`customerEmail` is null — a tombstoned or guest buyer — is warn-logged and skipped.

**Retry.** `RetryFailedDeliveriesUseCase` sweeps `failed` deliveries under
`MAX_DELIVERY_ATTEMPTS` on exponential backoff (`baseMs · 2^(attemptCount-1)`), driven by
`DeliveryRetryScheduler` (`@Interval`). An operator can force one now via
`POST /api/notifications/deliveries/:id/retry` — it re-dispatches the row's **already-rendered**
subject/body (no template re-lookup; the row is a self-contained snapshot) and ignores the
backoff gate. At the cap the service emits `notifications.delivery.failed` exactly once.

Rendering is Handlebars (`HandlebarsTemplateRendererAdapter`, the only `handlebars` import).
`{{ }}` HTML-escapes the render context by default — the right posture for trusted,
staff-authored template *source* over untrusted context *data*. No `{{{ triple-stache }}}`.

`record-outcome` (`sent → delivered | bounced`) is the **ESP-webhook seam** — RPC-only, no
gateway route; real webhook ingestion with signature verification is future work.

### Event store and audit log (`event-store-microservice`)

The sixth deployable — RMQ-only, no HTTP — is the append-only sink for two streams, in its
**own** database `ris_eventstore`.

| Table | Purpose | Dedupe |
| --- | --- | --- |
| `domain_event` | verbatim capture of every business event on the bus | composite UNIQUE `(producer, event_type, aggregate_id, occurred_at, correlation_id)` — an empty correlation id is coalesced to `''`, since MySQL treats `NULL`s as distinct |
| `audit_log_entry` | who-did-what for every staff mutation, with `before`/`after` snapshots | **none** — two identical staff actions a second apart are two real events |

Both are **append-only in the table shape itself**: neither entity extends `BaseEntity`
(no `updated_at`/`deleted_at` at all — only `received_at` beside `occurred_at`), and both
repositories implement their port **directly** rather than through `BaseTypeormRepository`,
whose `save`/`softDelete` would break the invariant. The ports expose `append` + reads only.

`DomainEvent` and `AuditLogEntry` are **frozen value objects**, not aggregate roots: every
field `public readonly`, `Object.freeze`d in the constructor, `create` / `reconstitute`
factories, no mutators, no domain events. An invariant violation throws a plain `Error` —
it can only be an internal caller bug, because the ingest validates first.

One `FirehoseConsumer` reads the concrete routing key off
`context.getMessage().fields.routingKey` and dispatches: `audit.staff.action` →
`IngestAuditLogUseCase`, everything else → `IngestDomainEventUseCase`. It **warn-swallows**
and never rethrows. It sits beside the aggregator module rather than inside either sibling
module because it injects use cases from **both**, and `eslint-plugin-boundaries` only lets a
module's `infrastructure/` inject its own.

`producer` / `aggregateType` / `aggregateId` are heuristically resolved by
`firehose-extractors.ts` (producer ← first routing-key token; aggregateType ← second;
aggregateId ← first present of a documented payload-key precedence). A missing or `NaN`
`occurredAt` is warn-and-dropped.

**The logs can be read back over RPC** ([ADR-039](docs/adr/039-audit-and-event-store-query-surface.md)).
`QueryDomainEventsUseCase` and `QueryAuditLogEntriesUseCase` are filtered, paginated and
newest-first, over **indexed columns only** (the JSON `payload` / `before` / `after` are
returned but never searched); `TraceByCorrelationUseCase` is an unpaginated ascending timeline
of everything one correlation id touched, across both logs. Page size is capped at 100 in the
use case, so every caller inherits the cap. An unknown id or an inverted `from`/`to` range
yields an empty result, never an error: the event store has no domain-exception type, and
therefore no RPC exception filter.

They are served by the `AuditQueryController` on a **second queue**,
`event_store_query_queue`, bound to the default exchange — command traffic never rides the
`ris.events` topic exchange:

| Routing key | Use case |
| --- | --- |
| `audit.event.query` | `QueryDomainEventsUseCase` |
| `audit.entry.query` | `QueryAuditLogEntriesUseCase` |
| `audit.trace.by-correlation` | `TraceByCorrelationUseCase` |

`main.ts` is therefore a **hybrid app**: `NestFactory.create` + two `connectMicroservice`
calls + `init()` + `startAllMicroservices()`. It never calls `listen()`, so the service still
opens no TCP port. `audit.staff.action` remains the one `audit.` *event* — it rides
`ris.events` into the firehose queue and is never routed here.

The gateway's `modules/audit/` fronts all three at `GET /api/audit/events`,
`GET /api/audit/entries` and `GET /api/audit/trace/:correlationId`, behind `audit:read`
([§6](#6-http-api)).

---

## 5. Cross-cutting guarantees

### Idempotency

Four money-/stock-moving routes **require** an `Idempotency-Key` header and are
storage-backed deduplicated ([ADR-036](docs/adr/036-idempotency-key-store-and-enforced-occ.md)):

```
POST /api/cart/:cartId/place
POST /api/orders/:orderId/payments/capture
POST /api/orders/:orderId/fulfillments/:fulfillmentId/ship
POST /api/orders/:orderId/refunds
```

Semantics are uniform:

| Case | Result |
| --- | --- |
| **Missing header** | `400`. Rejected at the gateway edge by the reusable `@IdempotencyKey()` decorator (`IDEMPOTENCY_KEY_REQUIRED`) before any RPC; retail carries an `ORDER_IDEMPOTENCY_KEY_REQUIRED` backstop for a direct-RMQ caller. |
| **Replay** (same key, same body) | The stored response body, `200`, header `Idempotent-Replay: true`. Replayed **without re-executing** — no second charge, no second stock movement, no re-emitted events, and for refund no second `audit_log_entry`. |
| **Reuse** (same key, different body) | `422 ORDER_IDEMPOTENCY_KEY_REUSED`, fired **before any side effect** (for refund, before the gateway call) — a changed amount can never slip through. |

"Same body" is an identical **canonical-JSON + SHA-256 fingerprint** of the
client-controlled command. Transport and identity noise (`correlationId`, the key itself,
owner-injected ids like `customerId`) is excluded, so a retry under a fresh correlation id
still matches.

The store is **one retail-owned `idempotency_key` table in `retail_db`** — local to the
producing service, *not* a shared cross-service store. Inventory needs none: Reserve is
natural-key idempotent on `(cartId, variantId, stockLocationId)`; Commit-sale and Restock are
idempotency-first on `fulfillmentId` / `returnRequestId`.

The store is **live-ephemeral**: `find` never filters by expiry, so a 10-minute
`IdempotencyPurgeScheduler` sweep is the *sole* deleter of rows past
`IDEMPOTENCY_KEY_TTL_HOURS` — a single bounded `DELETE … WHERE expires_at < now` over the
`expires_at` index.

### Optimistic concurrency (OCC)

Every operational aggregate write is a read-version → mutate →
`UPDATE … SET version = version + 1 WHERE id = ? AND version = ?` compare-and-swap. Zero rows
affected means a concurrent writer won: the attempt re-reads under a **fresh transaction**
and retries up to `OCC_RETRY_ATTEMPTS` (default 5, injected as a per-module value-provider
token — never `process.env`). On exhaustion the write surfaces a uniform
`409 { code: 'VERSION_MISMATCH', details: { currentVersion } }`.

| Aggregate | Exhaustion code |
| --- | --- |
| `StockLevel`, `Reservation` | `409 STOCK_WRITE_CONFLICT` |
| `Cart`, `Order`, `Fulfillment`, `ReturnRequest` | `409 VERSION_MISMATCH` (member name is module-prefixed; the *wire* value is uniform) |

The three cart line writes additionally honour an optional **`If-Match: <version>`**
precondition (the `@IfMatch()` gateway decorator): a stale pin is an immediate `409` with
**no** retry — HTTP precondition-failed semantics, because the client's view moved. Absent
the header, last-writer-within-budget wins.

The gateway also carries a global `OptimisticLockVersionMismatchError → 409` filter as
defense-in-depth for gateway-local OCC.

**Two legitimate 409s.** A *same-transition* CAS loss is retried within budget, then
surfaces `VERSION_MISMATCH`. A *cross-transition* op that finds the state genuinely illegal
after serialization gets its terminal domain `409` (`ORDER_NOT_CANCELLABLE`,
`FULFILLMENT_INVALID_STATUS_TRANSITION`) and is **never** retried.

### Inventory invariants

**No-oversell.** `available` never goes negative. Reserve and the direct-allocate fallback
check `quantity ≤ available` *before* moving a counter and reject the overflow with
`409 INVENTORY_OUT_OF_STOCK` carrying `details.available`; Adjust and Transfer reject an
on-hand result below zero with `409 INVENTORY_STOCK_RESULT_NEGATIVE`. Check and write run in
**one transaction** under the version-checked retry protocol — which is what makes two carts
racing for the last unit deterministic: exactly one reserve wins, the loser sees
`available: 0`.

**Reservation TTL.** Every Reserve (re)sets `expiresAt = now + RESERVATION_TTL_MINUTES`, so
an active line refreshes its lease as the shopper edits the cart. A hold returns to
`available` four ways: cart Remove **releases** it, Place **allocates** it (after which only a
cancel-allocation frees it), an operator **manually releases** it by id, or — for a hold nobody
touches — `SweepExpiredReservationsUseCase` **expires** it, driven by the inventory service's
timer or by `POST /api/inventory/reservations/sweep` on demand
([§13](#13-background-jobs)). Between a hold's `expiresAt` and the tick that observes it,
`available` understates reality — the system under-sells, never over-sells — so the sweep
should tick well inside the TTL. A stranded hold is never lost either way: the next Reserve on
the same triple reuses the row. See
[ADR-038](docs/adr/038-reservation-ttl-sweep-and-bounded-batches.md).

**Audit, not balance.** `stock_movement` is an append-only audit trail; the running totals on
`stock_level` are the source of truth, and **summing ledger rows never reconstructs on-hand**.
`STOCK_MOVEMENT_REPOSITORY` exposes only `append`, `listByVariant`, and `existsByReference` —
UPDATE and DELETE are inexpressible. The append runs *after* the version-checked persist in
the same transaction, so a lost race leaves no orphan row and a retry appends exactly once.
Every counter-changing operation — Receive, Adjust, Transfer, Reserve's Release, Allocate,
Cancel Allocation, Commit Sale, Restock — leaves its movement.

### Privacy and consent

[ADR-037](docs/adr/037-consent-record-and-tombstone-erasure.md). Every customer has a
channel-consent record, marketing dispatch is consent-gated, and a customer's personal data
can be erased **without destroying the sales history**.

**`ConsentRecord`** is 1:1 with `Customer`, keyed on the customer's `CHAR(36)` UUID
(no `BaseEntity` — only `updated_at`). `transactionalEmail` defaults **true** (order mail is
operationally required); `marketingEmail` / `marketingSms` default **false** (opt-in). An
**absent row resolves to those defaults**, so consent is meaningful from the first read; a
`PUT` is an upsert-merge that changes only the fields it carries.

**Erasure is a tombstone, never a hard delete.** `POST /api/admin/customers/:id/erase`
(body `{ confirmEmail }`) nulls PII across `customer`, `address` (`owner_type='customer'`
rows only), and `cart` in **one transaction** via a gateway-owned raw-SQL
`CUSTOMER_ERASURE_WRITER`; flips `status='deleted'` + stamps `deleted_at`; and clears the
refresh-token hash (a session revoke). It **preserves the customer id**, so every
`order.customer_id` FK and the immutable `owner_type='order'` address snapshots stay intact.
A `confirmEmail` mismatch is a `400` with nothing written; an already-erased customer is an
idempotent no-op.

**PII never rides an event payload or an audit row.** The durable `ris.events` firehose and
`audit_log_entry` must not be re-seeded with the data an erase removes: `customer.erased`
carries ids + `erasedAt` only, and the erase audit `before`/`after` is
`{ id, status } → { status: 'deleted' }`.

**Two permission codes, not three.** `customer:read-consent` and `customer:erase` are
admin-only *staff overrides*. There is deliberately **no customer-facing consent code**: a
customer JWT carries no `permissions` claim, so a `@RequiresPermission('customer:…')` gate
would reject the very customers it targets. The customer's own consent path is authorized by
authentication + inherent ownership.

---

## 6. HTTP API

All routes are prefixed `/api`. Every route is **protected by default**; `@Public()` is the
explicit opt-out. Interactive reference: `http://localhost:3000/api/reference`.

### Auth — staff

| Method | Route | Auth |
| --- | --- | --- |
| `POST` | `/auth/staff/login` | public |
| `POST` | `/auth/login` | public — deprecated alias |
| `POST` | `/auth/refresh` | public |
| `POST` | `/auth/logout` | bearer |
| `GET` | `/auth/me` | bearer |
| `GET` | `/auth/admin/ping` | `audit:read` — smoke endpoint |

### Auth — customer

| Method | Route | Auth |
| --- | --- | --- |
| `POST` | `/auth/customer/register` | public |
| `POST` | `/auth/customer/login` | public |
| `POST` | `/auth/customer/guest-session` | public — mints a guest-tier token + `customerId` |
| `GET` | `/auth/customer/me` | bearer |
| `GET` | `/auth/customer/me/consent` | bearer — owner-inherent, **no permission code** |
| `PUT` | `/auth/customer/me/consent` | bearer — owner-inherent, **no permission code** |

### Catalog

| Method | Route | Auth |
| --- | --- | --- |
| `POST` | `/catalog/products` | `catalog:write` |
| `POST` | `/catalog/products/:productId/variants` | `catalog:write` |
| `POST` | `/catalog/products/:productId/publish` | `catalog:publish` |
| `POST` | `/catalog/products/:productId/archive` | `catalog:write` |
| `GET` | `/catalog/products` | public — paged active-catalogue browse |
| `GET` | `/catalog/products/:slug` | public — product + active variants |
| `GET` | `/catalog/variants/:variantId` | public — variant + parent product |

### Pricing and tax categories

| Method | Route | Auth |
| --- | --- | --- |
| `POST` | `/catalog/variants/:variantId/prices` | `pricing:write` — set or schedule |
| `GET` | `/catalog/variants/:variantId/prices` | public — `?currency=USD`, `?asOf` |
| `GET` | `/catalog/variants/:variantId/price` | public — single applicable price, or a null body |
| `POST` | `/catalog/tax-categories` | `pricing:write` |
| `GET` | `/catalog/tax-categories` | public |
| `PATCH` | `/catalog/variants/:variantId/tax-category` | `pricing:write` — attach by code |

### Categories and media

| Method | Route | Auth |
| --- | --- | --- |
| `POST` | `/catalog/categories` | `catalog:write` — create a root or child |
| `PATCH` | `/catalog/categories/:slug/parent` | `catalog:write` — reparent (or demote to root) + rebase the subtree |
| `GET` | `/catalog/categories` | public — flat active list, `?root` |
| `GET` | `/catalog/categories/:slug/tree` | public — nested active subtree |
| `GET` | `/catalog/categories/:slug/products` | public — `?includeDescendants`, `?page`, `?pageSize` |
| `POST` | `/catalog/products/:productId/categories` | `catalog:write` — attach (returns the full membership, `200`) |
| `DELETE` | `/catalog/products/:productId/categories/:categorySlug` | `catalog:write` — detach |
| `POST` | `/catalog/media` | `catalog:write` — append at `max(sort_order) + 1` |
| `PATCH` | `/catalog/media/reorder` | `catalog:write` — exact permutation, all-or-nothing |
| `DELETE` | `/catalog/media/:id` | `catalog:write` — `active → archived` flip |
| `GET` | `/catalog/products/:productId/media` | public — `sort_order ASC` |
| `GET` | `/catalog/variants/:variantId/media` | public — `sort_order ASC` |

Category and media authoring reuse `catalog:write` — **no new permission code was minted**.
An unknown media owner is a `200 []`, not a `404`.

### Inventory

| Method | Route | Auth |
| --- | --- | --- |
| `GET` | `/inventory/locations` | `inventory:read` — `?activeOnly` |
| `GET` | `/inventory/variants/:variantId/stock` | public — per-location availability + totals, `?locationIds=a,b` |
| `GET` | `/inventory/variants/:variantId/movements` | `inventory:read` — `?page`, `?pageSize`, `?type`, `?from`, `?to` |
| `POST` | `/inventory/variants/:variantId/stock/receive` | `inventory:adjust` — `{ stockLocationId?, quantity }` |
| `POST` | `/inventory/variants/:variantId/stock/adjust` | `inventory:adjust` — `{ stockLocationId?, quantityDelta, reasonCode }` |
| `POST` | `/inventory/variants/:variantId/stock/transfer` | `inventory:transfer` — `{ fromLocationId, toLocationId, quantity }` |
| `POST` | `/inventory/reservations/sweep` | `inventory:adjust` — `{ batchSize? }`, expires elapsed holds on demand |
| `POST` | `/inventory/reservations/:reservationId/release` | `inventory:adjust` — the operator manual release |

A variant with no stock rows is a `200` zero-availability answer (`locations: []`), not a
`404`. The two reservation routes share `inventory:adjust` because they do the same thing to
the books — return held units to `available` and append a `release` ledger row. The sweep runs
the same use case the inventory service's timer ticks and answers
`{ scanned, expired, skipped, durationMs }` where `scanned = expired + skipped`; it needs no
`Idempotency-Key`, since a second call finds the holds already `expired` and skips them. The
by-id release needs a `reservationId` — source it from the reserve-path logs, the
`inventory.stock.reserved` event, or the DB; there is no reservation read endpoint by design.

### Cart

Bearer plus an **owner-check**, no permission code — a customer touches only its own cart.

| Method | Route | Notes |
| --- | --- | --- |
| `POST` | `/cart` | open a cart |
| `GET` | `/cart/:cartId` | |
| `POST` | `/cart/:cartId/lines` | add a priced line — reserves stock; optional `If-Match: <version>` |
| `PATCH` | `/cart/:cartId/lines/:lineId` | change quantity — re-reserves; optional `If-Match` |
| `DELETE` | `/cart/:cartId/lines/:lineId` | remove a line — releases the hold best-effort; optional `If-Match` |
| `POST` | `/cart/:cartId/claim` | promote a guest cart (`fromCustomerId` proof; no inventory call) |
| `POST` | `/cart/:cartId/place` | place the order — `Idempotency-Key` **required**; `201` fresh, `200` + `Idempotent-Replay: true` on replay |

### Orders, fulfillment, refunds

| Method | Route | Auth |
| --- | --- | --- |
| `GET` | `/orders` | bearer — own orders, paginated, newest-first |
| `GET` | `/orders/:orderId` | owner **or** staff `order:read` |
| `POST` | `/orders/:orderId/payments/capture` | owner **or** staff `order:capture` — `Idempotency-Key` required |
| `POST` | `/orders/:orderId/fulfillments` | `order:fulfill` — `201` |
| `GET` | `/orders/:orderId/fulfillments` | owner **or** staff `order:read` |
| `POST` | `/orders/:orderId/fulfillments/:id/ship` | `order:fulfill` — captures payment; `Idempotency-Key` required |
| `POST` | `/orders/:orderId/fulfillments/:id/deliver` | `order:fulfill` |
| `POST` | `/orders/:orderId/cancel` | owner **or** staff `order:cancel` |
| `POST` | `/orders/:orderId/lines/:lineId/cancel` | staff `order:cancel` |
| `POST` | `/orders/:orderId/refunds` | staff `order:refund` — `Idempotency-Key` required; `201` fresh, `200` replay |
| `GET` | `/orders/:orderId/refunds` | owner **or** staff `order:read` |

**Two authorization shapes coexist.** Owner-or-staff routes carry **no
`@RequiresPermission`** — that would block the owning customer, who holds no permissions;
the staff override is computed at the gateway from `@CurrentUser().permissions` and the
owner-check is enforced retail-side. Staff-only routes are gated with `@RequiresPermission`
directly. A permission code is a *staff override over an owner-check*, never a customer gate.

### Returns (RMA)

| Method | Route | Auth |
| --- | --- | --- |
| `POST` | `/orders/:orderId/returns` | owner **or** staff `order:return-authorize` — `201` |
| `GET` | `/orders/:orderId/returns` | owner **or** staff `order:read` |
| `GET` | `/returns/:rmaId` | owner **or** staff `order:read` |
| `POST` | `/returns/:rmaId/authorize` | `order:return-authorize` |
| `POST` | `/returns/:rmaId/reject` | `order:return-authorize` — `{ reason }` |
| `POST` | `/returns/:rmaId/receive` | `inventory:receive-return` |
| `POST` | `/returns/:rmaId/inspect` | `inventory:receive-return` — per-line disposition; `restock` re-enters stock |
| `POST` | `/returns/:rmaId/close` | `order:return-authorize` |

### Notifications (staff-only admin/ops)

| Method | Route | Auth |
| --- | --- | --- |
| `GET` | `/notifications/templates` | `notifications:write` — every version, `?eventType`, `?channel`, `?locale` |
| `POST` | `/notifications/templates` | `notifications:write` — author/edit a version, `201` |
| `PATCH` | `/notifications/templates/:id/active` | `notifications:write` — `{ active }`, the rollback lever |
| `GET` | `/notifications/deliveries` | `notifications:read` — `?customerId`, `?eventReferenceType`, `?eventReferenceId`, `?status`, `?page`, `?pageSize` |
| `GET` | `/notifications/deliveries/:id` | `notifications:read` — one row, incl. `renderedBody` |
| `POST` | `/notifications/deliveries/:id/retry` | `notifications:write` — forces past the backoff gate |
| `POST` | `/notifications/marketing/send` | `notifications:write` — `{ customerId, customerEmail, eventType?, campaignId?, context? }`; the consent gate decides send vs `skipped-no-consent` |

The gateway resolves the `marketing.email.promo` default and **mints a fresh `campaignId`
per request**, so repeated sends are distinct rows. `customerEmail` is a documented operator
input, not a cross-module lookup.

### Audit and event store (staff-only)

| Method | Route | Auth |
| --- | --- | --- |
| `GET` | `/audit/events` | `audit:read` — `?eventType`, `?aggregateType`, `?aggregateId`, `?correlationId`, `?from`, `?to`, `?page`, `?pageSize` |
| `GET` | `/audit/entries` | `audit:read` — `?actorId`, `?entityType`, `?entityId`, `?action`, `?correlationId`, `?from`, `?to`, `?page`, `?pageSize` |
| `GET` | `/audit/trace/:correlationId` | `audit:read` — both logs for one request, each oldest-first |

Three questions: *what did the system do* (`domain_event`), *what did a person do*
(`audit_log_entry`), *what did this one request cause* (both, joined by correlation id). Every
filter is optional and names an **indexed** column — the JSON bodies (`payload`, `before`,
`after`) are returned but never searched.

`pageSize` defaults to 20 and is **capped at 100 by the event store's use case**, not by the
gateway DTO, so a direct RPC caller inherits the same ceiling. The DTO owns shape instead: an
inverted `from`/`to` window is a `400` here, because the event store would answer it with a
silently empty page. Nothing in this area ever returns a `404` — an unknown correlation id is a
`200` with two empty arrays, and an unmatched filter set a `200` empty page.

`?action=` takes the stable **event-name** string (`StaffUserRolesAssigned`, `RefundIssued`),
never a permission code — the ingest maps `action ← IAuditLogEvent.name`. A permission code in
that slot is a well-formed query that matches nothing.

One worked example each:

```http
GET /api/audit/events?eventType=retail.order.placed&from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z&pageSize=50
GET /api/audit/entries?action=StaffUserRolesAssigned&actorId=00000000-0000-4000-a000-000000000001
GET /api/audit/trace/9f1c0e2a-7b4d-4c8e-9a11-6d3f5b2c0e77
```

`aggregateType` and `aggregateId` are the routing key's **second token** and the payload id it
names, resolved per event — so `?aggregateType=order` matches `retail.order.placed` and
`retail.order.cancelled`, and *not* that order's payment, fulfillment or refund events, which are
extracted under their own type and their own id. Reassembling one order's whole story is what
`?correlationId=` and the trace route are for.

### Admin

| Method | Route | Auth |
| --- | --- | --- |
| `GET` | `/iam/roles` | `iam:role-edit` |
| `POST` | `/iam/roles` | `iam:role-edit` |
| `PATCH` | `/iam/roles/:id` | `iam:role-edit` |
| `POST` | `/iam/staff/:id/roles` | `iam:assign` |
| `DELETE` | `/iam/staff/:id/roles/:roleName` | `iam:assign` |
| `GET` | `/admin/customers/:id/consent` | `customer:read-consent` |
| `POST` | `/admin/customers/:id/erase` | `customer:erase` — `{ confirmEmail }`; `400` on mismatch; idempotent |

### Error contract

A domain rejection throws the module's `*DomainException`, which its presentation
`*RpcExceptionFilter` maps to an HTTP status. The gateway's `throwRpcError` forwards the
upstream **typed `code`** and any object-valued **`details`** verbatim, so a client branches
on a stable code rather than a message:

```json
{ "statusCode": 409, "code": "INVENTORY_OUT_OF_STOCK", "details": { "available": 0 } }
{ "statusCode": 409, "code": "VERSION_MISMATCH",       "details": { "currentVersion": 7 } }
```

---

## 7. Authentication and authorization

Three global guards run on every route, in order: `JwtAuthGuard` (presence + signature) →
`RolesGuard` (`@Roles(...)`, coarse) → `PermissionsGuard` (`@RequiresPermission(...)`, precise).

`@Public()` routes today: `/auth/staff/login`, `/auth/login`, `/auth/refresh`,
`/auth/customer/register`, `/auth/customer/login`, `/auth/customer/guest-session`, the public
catalog browse/resolve + price/tax-category reads, and `GET /inventory/variants/:id/stock`.

Two subject kinds share the pipeline:

- **`StaffUser`** — operators with one or more `Role`s, each binding a set of `Permission`
  codes. The access token's `permissions: string[]` claim is the union, inflated at
  login/refresh.
- **`Customer`** — buyer identity. No roles, **no `permissions` claim** — a customer token
  never satisfies any `@RequiresPermission(...)`, by design.

### Login + refresh

```
1. POST /api/auth/staff/login { email, password }        # or /auth/customer/login
   ↳ verify password (argon2id)
   ↳ load roles → flatten permission codes (staff only)
   ↳ issue access JWT   (HS256, 15m, JWT_ACCESS_SECRET; roles + permissions for staff)
   ↳ issue refresh JWT  (HS256, 7d,  JWT_REFRESH_SECRET)
   ↳ store an argon2id hash of the refresh JWT on the subject row
   ↳ → { accessToken, refreshToken, expiresIn }

2. POST /api/auth/refresh { refreshToken }
   ↳ verify signature + expiry
   ↳ argon2.verify(stored hash, presented token)
       ↳ mismatch ⇒ rotation reuse: clear the stored hash + 401
   ↳ re-inflate the staff permissions claim (so /iam role edits propagate)
   ↳ issue a new pair, store the new hash

3. POST /api/auth/logout (bearer)
   ↳ clear the refresh hash; subsequent /auth/refresh fails 401
```

Refresh tokens **rotate on every refresh**; reuse of a stale token trips a circuit-breaker
that clears the live hash entirely. IAM role edits take effect at the next refresh
(≤ 15 min by default) — access tokens already in circulation keep their pre-edit claim.

### Roles and permissions

Roles live in `role`, bound to codes through `role_permissions`; staff acquire roles through
`staff_user_roles`. The source of truth for codes is `PermissionCodeEnum` in
[`libs/contracts/auth/permission.enum.ts`](libs/contracts/auth/permission.enum.ts); the four
seeded bundles live in `scripts/test-db-seed.ts`.

| Role | Permission codes |
| --- | --- |
| `admin` | every code |
| `catalog-manager` | `catalog:read`, `catalog:write`, `catalog:publish`, `pricing:write` |
| `warehouse-staff` | `inventory:read`, `inventory:adjust`, `inventory:transfer`, `inventory:receive-return`, `order:fulfill`, `order:cancel` |
| `order-support` | `order:read`, `order:capture`, `order:fulfill`, `order:cancel`, `order:refund`, `order:return-authorize` |

<details>
<summary>Every seeded code and the roles it appears in</summary>

| Code | Roles |
| --- | --- |
| `catalog:read` | `admin`, `catalog-manager` |
| `catalog:write` | `admin`, `catalog-manager` |
| `catalog:publish` | `admin`, `catalog-manager` |
| `pricing:write` | `admin`, `catalog-manager` |
| `inventory:read` | `admin`, `warehouse-staff` |
| `inventory:adjust` | `admin`, `warehouse-staff` |
| `inventory:transfer` | `admin`, `warehouse-staff` |
| `inventory:receive-return` | `admin`, `warehouse-staff` |
| `order:read` | `admin`, `order-support` |
| `order:capture` | `admin`, `order-support` |
| `order:fulfill` | `admin`, `warehouse-staff`, `order-support` |
| `order:cancel` | `admin`, `warehouse-staff`, `order-support` |
| `order:refund` | `admin`, `order-support` |
| `order:return-authorize` | `admin`, `order-support` |
| `notifications:read` | `admin` |
| `notifications:write` | `admin` |
| `iam:assign` | `admin` |
| `iam:role-edit` | `admin` |
| `audit:read` | `admin` |
| `customer:read-consent` | `admin` |
| `customer:erase` | `admin` |

</details>

A new code auto-seeds to `admin` only when it is also added to the `PERMISSION_SEEDS` array
in `scripts/test-db-seed.ts` — the `admin` role binds `Object.values(PermissionCodeEnum)`,
but the seeder resolves each code's row id from that array.

Guard a controller method on a precise code:

```ts
@Get('roles')
@RequiresPermission(PermissionCodeEnum.IAM_ROLE_EDIT)
public list(): Promise<RoleResponseDto[]> { … }
```

Passwords use **argon2id** (OWASP 2024 defaults). Staff actions are audited through
`AUDIT_LOG_PUBLISHER` → `RmqAuditLogPublisher` → `audit.staff.action` on `ris.events` →
`audit_log_entry` — login, refresh, logout, the `iam` role mutations, and every refund.

ADRs: [010](docs/adr/010-jwt-rbac-at-the-gateway.md),
[024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md).

---

## 8. Configuration

Validated by a single Joi schema in [`libs/config`](libs/config/config-module.config.ts)
(`allowUnknown`, `abortEarly: false`). Copy `.env.example` → `.env.local` for host-side
`yarn start:dev`.

### Required

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `development` \| `production` \| `test` |
| `API_GATEWAY_PORT` | gateway HTTP port |
| `DATABASE_URL` | `mysql://…/retail_db` — the shared operational schema |
| `EVENTSTORE_DATABASE_URL` | `mysql://…/ris_eventstore` — the isolated event-store schema. Required in **every** service's env (one shared Joi schema), but only the event store opens it. |
| `RABBITMQ_URL` | `amqp://…` |
| `REDIS_URL` | `redis://…` |
| `JWT_ACCESS_SECRET` | ≥ 32 chars |
| `JWT_REFRESH_SECRET` | ≥ 32 chars; **must differ** from the access secret so it can be rotated independently |
| `OTEL_SERVICE_NAME` | distinct per service — Jaeger's "Service" filter |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | e.g. `http://otel-collector:4318/v1/traces` |

### Defaulted

| Variable | Default | Role |
| --- | --- | --- |
| `API_GATEWAY_PREFIX` | — | global route prefix (`api` in compose) |
| `API_GATEWAY_USE_API_REFERENCE` | `NODE_ENV !== 'production'` | serve `/api/reference` |
| `DATABASE_LOGGING` | `NODE_ENV !== 'production'` | TypeORM query log |
| `DEFAULT_CURRENCY` | `USD` | ISO-4217 currency the catalog publish price gate resolves against |
| `LOG_LEVEL` | `debug` dev / `info` prod | `trace` … `fatal` |
| `CACHE_TTL_MS_DEFAULT` | `60000` | global default for an unscoped `set()` |
| `CACHE_TTL_MS_PRODUCT_STOCK` | `60000` | TTL for a cached availability read (the name predates the running-totals rewrite) |
| `RESERVATION_TTL_MINUTES` | `15` | hold lifetime — `expiresAt = now + this` on every Reserve |
| `RESERVATION_SWEEP_BATCH_SIZE` | `200` | rows one expired-reservation sweep scans and expires; a ceiling a caller cannot raise |
| `RESERVATION_SWEEP_TRANSACTION_SIZE` | `25` | rows one sweep transaction expires — bounds how long it holds row locks |
| `RESERVATION_SWEEP_INTERVAL_SECONDS` | `60` | seconds between sweep invocations; decides how promptly an already-expired hold is reclaimed |
| `RETURN_WINDOW_DAYS` | `30` | a `shipped` order is returnable only within this window; a `delivered` one always is |
| `OCC_RETRY_ATTEMPTS` | `5` | bounded retry budget for version-checked writes |
| `IDEMPOTENCY_KEY_TTL_HOURS` | `24` | idempotency-record retention; the 10-minute purge sweep reclaims past-`expires_at` rows |
| `OPS_NOTIFICATIONS_EMAIL` | `ops@example.com` | mailbox for system-only notifications with no customer recipient |
| `MAX_DELIVERY_ATTEMPTS` | `3` | attempts before a delivery is abandoned and `notifications.delivery.failed` is emitted |
| `RETENTION_DELIVERY_DAYS` | `90` | delivery-row retention; Joi-validated, no reader — see [Not built yet](#14-not-built-yet) |
| `NOTIFICATIONS_CONSENT_CACHE_TTL_SECONDS` | `300` | staleness safety net; the consent cache is kept fresh by events, not TTL |
| `NOTIFIER_TEST_FLAKY` | `false` | **test-only** — swaps in a flaky notifier that fails the first dispatch of any `__FAIL_ONCE__`-marked body. Never set it outside the retry e2e suite. |
| `AUTH_ARGON2_MEMORY_COST` | `19456` KiB | OWASP 2024 minimum for argon2id |
| `AUTH_ARGON2_TIME_COST` | `2` | iterations |
| `AUTH_ARGON2_PARALLELISM` | `1` | threads |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | `ms`-style string |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | |
| `OTEL_RESOURCE_ATTRIBUTES` | — | merged into the OTel `Resource` |
| `OTEL_SDK_DISABLED` | `false` | short-circuit the SDK at boot |

---

## 9. Development workflow

### Scripts

Six service names are valid everywhere a `<service>` appears: `api-gateway`,
`inventory-microservice`, `retail-microservice`, `notification-microservice`,
`catalog-microservice`, `event-store-microservice`.

| Script | Description |
| --- | --- |
| `yarn start:dev` | Start all six services concurrently, watch reload (`scripts/bash/start-dev.sh`). |
| `yarn start:dev:<service>` | Start one service with watch reload. |
| `yarn start:prod:<service>` | Run a built service from `dist/`. |
| `yarn build` | `nest build --all`. |
| `yarn build:<service>` | Build one app. |
| `yarn lint` | Full ESLint pass incl. `boundaries/*`, `--max-warnings 0` (CI gate). |
| `yarn lint:fix` | Auto-fix what can be auto-fixed. |
| `yarn format` / `yarn format:check` | Prettier write / check-only (CI gate). |

### Migrations

Two pipelines, two `migrations` ledgers.

| Script | Target |
| --- | --- |
| `yarn migration:create <Name>` | scaffold under `migrations/` |
| `yarn migration:run` / `:revert` / `:show` | `retail_db` |
| `yarn migration:create:eventstore <Name>` | scaffold under `migrations/eventstore/` |
| `yarn migration:run:eventstore` / `:revert:eventstore` / `:show:eventstore` | `ris_eventstore` |
| `yarn typeorm:migration-cli` | the raw TypeORM CLI hook the `retail_db` commands wrap |

`DatabaseModule.forRoot(entities)` pins `mysql2` to UTC (`timezone: 'Z'`) so JS `Date`s
write and read as UTC wall-clock — matching the MySQL server clock and `UTC_TIMESTAMP()`,
which the pricing publish-precondition probe compares `price.valid_from` against. Without it
the driver would default to the Node host's local timezone.

### Testing

| Script | Description |
| --- | --- |
| `yarn test:unit` | Jest unit suite (`jest.unit.config.js`). |
| `yarn test:e2e` | `test:infra:reload`, then the full e2e suite against a clean database. |
| `yarn test:e2e:run` | e2e only — assumes infra is up. |
| `yarn test:infra:up` / `:down` | start / tear down MySQL + Redis + RabbitMQ (`down` drops volumes). |
| `yarn test:infra:reload` | down → up → **both** migration runs → seed. |
| `yarn test:seed` | deterministic fixtures from `scripts/test-db-seed.ts`. |

**E2E suites drive gateway HTTP and assert through public state** — order/refund reads, the
public stock read, the uncached movements ledger, the delivery audit reads, and (as the
"exactly one event" oracle) direct SQL against `ris_eventstore`. Never an event spy.

| Capability | Suites |
| --- | --- |
| Reservations + movements | `cart-reserve-release`, `place-order-allocates`, `inventory-movements-audit`, **`concurrent-oversell`** |
| Reservation TTL sweep | `reservation-sweeper`, `reservation-sweeper-cron`, **`concurrent-sweep-release`** |
| Fulfillment + ship + cancel | `fulfillment-happy-path`, `fulfillment-partial-ship`, `cancel-order-pre-fulfillment`, `cancel-order-blocked-after-ship`, `ship-triggers-capture`, **`concurrent-ship-cancel`** |
| Returns + refunds | `return-restock-refund`, `return-rejected`, `auto-refund-from-cancel`, `manual-refund` |
| Notifications | `notifications-place-order`, `notifications-ship-fulfillment`, `notifications-low-stock`, `notifications-template-edit`, `notifications-retry`, `notification` |
| Event store | `event-store-firehose`, `event-store-audit-log`, `event-store-idempotency` |
| Audit + event-store reads | `audit-event-query`, `audit-entry-query`, `audit-trace-correlation` |
| Idempotency + OCC | `idempotency-{place-order,different-body,capture,ship,refund,purge}`, `occ-cart`, `concurrent-place-order`, `inventory-concurrency` |
| Consent + erasure | `consent-roundtrip`, `notification-consent-gating`, `erase-customer-tombstone`, `erase-customer-confirm-guard` |

The three concurrency proofs (`concurrent-oversell`, `concurrent-ship-cancel`,
`concurrent-sweep-release`) are **winner-agnostic** and must stay green across five consecutive
runs. See [the concurrent-oversell walkthrough](docs/implementation/07-inventory-reservation-and-stock-movement/11-concurrent-oversell-e2e.md)
and [the sweep-vs-release walkthrough](docs/implementation/14-reservation-sweeper-and-audit-queries/08-sweep-vs-release-race-and-e2e-coverage.md).

The ingest suites (`event-store-*`, `idempotency-place-order`, `idempotency-refund`) assert by
direct SQL even though `GET /api/audit/*` could answer the same questions: a suite proving the
**write** path must not depend on the read path to do it.

### Request collections

Every endpoint is authored in **both** libraries, in lockstep: Kulala `*.http` files under
[`http/kulala/`](http/kulala/) and the [posting.sh](https://posting.sh) collection under
[`http/posting/`](http/posting/). See [`http.md`](http.md).

---

## 10. Seed data

`yarn test:seed` is **idempotent** — every row uses a fixed id and `INSERT IGNORE` (or a
`WHERE NOT EXISTS` guard where there is no surrogate id), so re-running it never duplicates
or errors. SQL files apply in FK-safe order (`scripts/utils/test-db-seed.util.ts`).

The migration auto-provisions exactly one `StockLocation` — `default-warehouse` — before any
seed runs, so there is always a location to read from and write to.

<details>
<summary>Catalog: two products, four variants</summary>

| Variant id | SKU | Product (slug) | Status |
| --- | --- | --- | --- |
| 1 | `AURORA-WARM` | `aurora-desk-lamp` | active |
| 2 | `AURORA-COOL` | `aurora-desk-lamp` | active |
| 3 | `NIMBUS-BLACK` | `nimbus-office-chair` | active |
| 4 | `NIMBUS-GREY` | `nimbus-office-chair` | active |

</details>

<details>
<summary>Categories, memberships, media</summary>

| id | Name | Slug | Parent | `path` | Sort |
| --- | --- | --- | --- | --- | --- |
| 1 | Electronics | `electronics` | — | `/electronics` | 0 |
| 2 | Phones | `phones` | 1 | `/electronics/phones` | 0 |
| 3 | Apparel | `apparel` | — | `/apparel` | 1 |

Product 1 (`aurora-desk-lamp`) is a member of both `electronics` and `phones`, so
`GET /api/catalog/categories/electronics/products?includeDescendants=true` returns it —
directly and via the descendant.

| Media id | Owner | Type | `sort_order` |
| --- | --- | --- | --- |
| 1 | product 1 | image | 0 |
| 2 | product 1 | video | 1 |

</details>

<details>
<summary>Pricing, tax categories, stock</summary>

Every variant carries one **open** `USD` price (`valid_to IS NULL`) with a fixed *past*
`valid_from`, so the applicable-price read answers immediately after a seed: variants 1–2 at
`4999` ($49.99), variants 3–4 at `19999` ($199.99).

Three tax categories exist as labels only, none attached to a variant: `STANDARD`,
`REDUCED`, `EXEMPT`.

Every variant has 100 on hand at `default-warehouse` (0 allocated, 0 reserved).
A second active location, `backup-store`, is seeded with no stock — so Transfer Stock has a
destination on a fresh database.

</details>

<details>
<summary>Cart, consent, notification templates</summary>

One example cart (`00000000-0000-4000-d000-000000000001`, `active`, variant 1 × 2) for the
seeded customer, purely a development convenience — the e2e suites build their own. The id
uses the `d000` (carts) namespace, alongside `a000` (users), `b000` (permissions), and
`c000` (roles).

One `consent_record` for the seeded customer at the capability defaults
(`transactional_email=1`, `marketing_email=0`, `marketing_sms=0`,
`data_retention_policy='default-7-years'`). It is not strictly required — an absent row
already resolves to exactly these defaults — but it exercises the persistence and gives the
customer an inspectable state.

**Eleven** `notification_template` rows, all `channel='email'`, `locale='en-US'`,
`version=1`, `active=1`. Ten are one-per-consumed-event-type; the eleventh is the marketing
template. Without a matching template the pipeline warn-logs and persists no delivery, so
this seed is what makes a real `notification_delivery` row appear end to end.

| `event_type` | Subject (Handlebars) |
| --- | --- |
| `retail.order.placed` | `Order #{{orderNumber}} confirmed` |
| `retail.order.cancelled` | `Order #{{orderId}} cancelled` |
| `retail.fulfillment.shipped` | `Order #{{orderId}} has shipped` |
| `retail.fulfillment.delivered` | `Your order arrived` |
| `retail.return.requested` | `Return {{rmaNumber}} received` |
| `retail.return.authorized` | `Return {{rmaNumber}} authorized` |
| `retail.return.received` | `Return {{rmaNumber}} received at warehouse` |
| `retail.return.inspected` | `Return {{rmaNumber}} inspected` |
| `retail.refund.issued` | `Refund issued` |
| `inventory.stock.low` | `Low stock alert` |
| `marketing.email.promo` | `A special offer just for you, {{customerName}}` |

Each `{{placeholder}}` on the ten transactional templates matches an actual field on that
event's contract (the shipment and cancellation events carry `orderId` but no `orderNumber`,
so those key on `orderId`). The marketing template renders against the operator-supplied
`context`. An over-the-API author appends a **higher** version, so a later edit or rollback
never touches these baseline rows.

</details>

---

## 11. Observability

### Structured logging

All services emit JSON logs via [Pino](https://github.com/pinojs/pino) through `nestjs-pino`.

| Environment | Format |
| --- | --- |
| `NODE_ENV=production` | JSON, one object per line, to stdout |
| anything else | human-readable via `pino-pretty` |

Every line carries at least `level`, `time`, `app`, `context`, `correlationId`, `msg` — plus
`traceId` / `spanId` when emitted inside an active OTel span
([ADR-015](docs/adr/015-pino-trace-correlation.md)).

### Correlation IDs

`CorrelationMiddleware` runs on every inbound gateway request: it honours an incoming
`x-correlation-id` header, or generates a UUID v4. The id is written back into the response
headers and forwarded on every downstream RabbitMQ payload. Microservices extract it and pass
it explicitly to each log call — no shared async context.

> Never use `PinoLogger.assign()` inside an `@EventPattern` handler: those are not
> request-scoped and it throws. Log `correlationId` inline
> ([ADR-011](docs/adr/011-notifier-port-and-adapters.md) §7).

```bash
# from a log file
cat logs.json | jq 'select(.correlationId == "a1b2c3d4-…")'

# live from a running service
yarn start:dev:retail-microservice 2>&1 | jq 'select(.correlationId == "a1b2c3d4-…")'
```

A single `POST /api/inventory/variants/1/stock/adjust` whose delta crosses the low-stock
threshold produces one correlated trail across three processes:

```json lines
{"level":30,"app":"api-gateway","correlationId":"a1b2…","req":{"method":"POST","url":"/api/inventory/variants/1/stock/adjust"},"msg":"incoming request"}
{"level":30,"app":"api-gateway","correlationId":"a1b2…","context":"AdjustStockUseCase","pattern":"inventory.stock-level.adjust","msg":"Sending RPC to inventory service"}
{"level":30,"app":"inventory-microservice","correlationId":"a1b2…","context":"AdjustStockUseCase","variantId":1,"quantityDelta":-8,"reasonCode":"damage","msg":"Received RPC: adjust stock"}
{"level":30,"app":"inventory-microservice","correlationId":"a1b2…","context":"AdjustStockUseCase","variantId":1,"stockLocationId":"default-warehouse","quantityOnHand":2,"msg":"Stock adjusted"}
{"level":30,"app":"inventory-microservice","correlationId":"a1b2…","context":"AdjustStockUseCase","pattern":"inventory.stock.low","quantity":2,"threshold":5,"msg":"Emitting low-stock event"}
{"level":30,"app":"notification-microservice","correlationId":"a1b2…","context":"RenderAndDispatchUseCase","deliveryId":42,"channel":"email","eventReferenceType":"stock-low","msg":"Notification dispatched"}
{"level":30,"app":"api-gateway","correlationId":"a1b2…","res":{"statusCode":200},"responseTime":50,"msg":"request completed"}
```

### Distributed tracing

Every service ships W3C-trace-context spans over OTLP/HTTP. One client request becomes one
trace that follows the HTTP entrypoint into the gateway and every RabbitMQ hop beyond it —
the AMQP `publish`/`process` span pairs are what stitch the services together.

The Jaeger UI and the collector live in a **separate compose overlay**, so day-to-day work
doesn't pay for them:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up

# …or stop just the observability containers when you're done
docker compose -f docker-compose.yml -f docker-compose.observability.yml stop jaeger otel-collector
```

| Endpoint | Purpose |
| --- | --- |
| `http://localhost:16686` | Jaeger UI — filter by service, search by trace id |
| `http://localhost:4317` | OTLP/gRPC ingress |
| `http://localhost:4318` | OTLP/HTTP ingress (the apps publish here) |

The collector config ([`infrastructure/otel-collector-config.yaml`](infrastructure/otel-collector-config.yaml))
is one pipeline: OTLP receiver → `batch` processor → OTLP exporter to Jaeger, plus a `debug`
exporter for local visibility. To go from a log line back to a trace, paste its `traceId`
into Jaeger's "Lookup by Trace ID".

### The "first import in `main.ts`" rule

> Every service's `main.ts` **must** `import '@retail-inventory-system/observability/tracer';`
> as its very first import.

The tracer bootstrap registers OTel's auto-instrumentations (HTTP, MySQL, Redis, amqplib),
and those must run before any patched module is `require()`d — otherwise instrumentation
does nothing and spans are silently missing. Enforced by review today.

ADRs: [001](docs/adr/001-structured-logging-with-pino.md),
[014](docs/adr/014-otel-exporter-otlp-http-and-jaeger.md),
[015](docs/adr/015-pino-trace-correlation.md).

---

## 12. Caching

Two read paths use Redis today, both **cache-aside**:

| Cached value | Key | Freshness |
| --- | --- | --- |
| `VariantStockView` — per-location `StockLevelView` rows + `totalOnHand` / `totalAvailable` | `ris:inventory:stock:v3:<variantId>:<facet>` | post-commit invalidation on every write |
| `ConsentRecordView` — a customer's channel-consent snapshot | `ris:notifications:consent:v1:<customerId>` | event-driven write-through / evict; TTL is only a safety net |

### Read flow (inventory)

```
1. QueryAvailabilityUseCase.execute()
2. STOCK_CACHE.getOrLoad(key, loader)
     hit  → return the cached VariantStockView
     miss → run the loader (single-flighted), write back, return
3. loader → STOCK_REPOSITORY.findStockLevelsByVariant(variantId, locationIds?)
     → point lookup of the variant's stock_level rows (no SUM/GROUP BY)
     → project to StockLevelView, sort by stockLocationId, sum totals
4. STOCK_CACHE.set(key, view, jittered TTL)
```

A variant with no rows in scope is a valid, cached **zero-availability** answer, not a 404.

### Key convention

```
ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]
```

`<version>` is a per-aggregate constant in `libs/cache/cache-keys.ts`
(`INVENTORY_STOCK_KEY_VERSION` is `v3`; the rest are `v1`). A breaking DTO change bumps it in
one line and orphans pre-bump entries, which then age out via TTL. The stock key went
`v1 → v2` when the value reshaped from a per-product `SUM` aggregate to the per-variant
`VariantStockView` (the key axis moving `productId → variantId`), then `v2 → v3` when TTL'd
reservations started moving `quantityReserved` — the same field set, a new meaning.

Stock-location ids are sorted with `localeCompare`, so callers passing the same set in a
different order generate an identical key. `__all__` is the sentinel for an unscoped read.
`t:<tenantId>` is opt-in and omitted entirely when absent — never defaulted.

**Apps must not write cache-key string literals** (call a `CACHE_KEYS` builder) and must not
import `@nestjs/cache-manager` / `@keyv/redis` directly (depend on `ICachePort`).

### TTL, single-flight, invalidation

- **TTL is a safety net, not the freshness mechanism** — explicit invalidation is.
  `StockCache.set` applies ±10% jitter before writing, so a batch of writes landing in one
  event-loop tick doesn't expire on the same wall-clock band.
- **Miss-path single-flight.** Concurrent misses on the same key fan out to a single
  repository call per process (`ICachePort.singleFlight`). A rejected loader propagates to
  every waiter — no silent retry-and-fan-out — and the in-flight slot clears on settlement.
- **Invalidation is post-commit and type-enforced** ([ADR-023](docs/adr/023-cache-invalidate-post-commit-by-type.md)).
  `IStockCachePort` has **no public `invalidate(...)`**; writes route through
  `withInvalidation(work, resolveItems, opts)`, which awaits `work()` — so the commit is
  durable — and only then fans out the prefix deletes. A future contributor cannot call it
  from inside the transaction body. Five `delByPrefix` calls run per affected `variantId`
  during the version-transition window (current `v3` plus four legacy prefixes). Each does
  `SCAN MATCH <prefix>*` then `UNLINK` — asynchronous free, no blocking O(N) delete on
  Redis's main thread.

### Graceful degradation

Every cache operation is wrapped in a `try/catch` that logs a `warn` and swallows:

- **Read failure** → `undefined`, the same contract as a miss; the caller falls through to MySQL.
- **Write failure** → swallowed; the response still returns.
- **Invalidation failure** → swallowed; the entry lives until its TTL.

A Redis outage degrades latency, never correctness. (The consent cache goes further: it
resolves to *defaults* on error, so an unreadable consent state never blind-sends marketing.)

### What is not cached

The location list, the catalog browse/resolve reads, the category navigation reads, and the
pricing reads all go straight to MySQL. Their read volume has not crossed the threshold where
cache-aside complexity (key versioning plus post-commit invalidation on every write) pays for
itself. The key shapes are already reserved — `CACHE_KEYS.catalogPrice(...)`,
`catalogCategoryTree()`, `catalogCategoryChildren(...)`, the `catalogProduct*` and
`notificationsTemplate*` blocks — versioned and ready, but no module imports `CacheModule` for
them. Caching them is gated on measured read pressure, not a missing feature.

### Inspecting the cache

```bash
redis-cli --scan --pattern 'ris:inventory:stock:v3:*'          # every cached availability entry
redis-cli GET  'ris:inventory:stock:v3:1:__all__'              # variant 1, aggregated
redis-cli PTTL 'ris:inventory:stock:v3:1:__all__'              # remaining TTL (ms)
redis-cli --scan --pattern 'ris:inventory:stock:v3:1:*' | xargs -r redis-cli UNLINK
```

ADRs: [002](docs/adr/002-redis-cache-aside-product-stock.md),
[006](docs/adr/006-cache-aside-via-libs-cache.md),
[016](docs/adr/016-cache-aside-generalized.md),
[021](docs/adr/021-cache-single-flight-and-ttl-jitter.md),
[022](docs/adr/022-cache-keys-tenant-and-schema-version.md),
[023](docs/adr/023-cache-invalidate-post-commit-by-type.md).

---

## 13. Background jobs

Three timers run inside three different services. Each one only decides how *promptly* an
already-due row is handled — none of them is load-bearing for correctness, and each wraps its
tick in a `try` / `catch` that warn-logs and returns, so a fault never stops the loop.

| Job | Registering file | Cadence | What a missed tick costs |
| --- | --- | --- | --- |
| Reservation TTL sweep | `apps/inventory-microservice/…/stock/infrastructure/scheduling/reservation-sweep.scheduler.ts` | `RESERVATION_SWEEP_INTERVAL_SECONDS` (default `60`) | stranded holds keep depressing `available` — the system under-sells |
| Idempotency-key TTL purge | `apps/retail-microservice/…/orders/infrastructure/idempotency/idempotency-purge.scheduler.ts` | fixed `@Cron`, every 10 minutes | `idempotency_key` keeps rows past `IDEMPOTENCY_KEY_TTL_HOURS`; the table grows |
| Notification delivery retry sweep | `apps/notification-microservice/…/notifications/infrastructure/scheduling/delivery-retry.scheduler.ts` | fixed `@Interval`, 60 s | a `failed` delivery waits one more interval for its next attempt |

Only the reservation sweep's cadence is configurable, which is why it alone registers its timer
imperatively through `SchedulerRegistry.addInterval` — a `@Cron` / `@Interval` argument is fixed
when the class is defined, before any injected value exists. The other two hardcode theirs in a
constant beside the decorator.

### Watching the reservation sweep

The sweep is the only job that moves stock, so it is the one worth observing. It leaves four
signals, in this order:

1. One `info` line at boot — `Reservation sweep scheduled` with `{ intervalSeconds }`. This is
   the only proof from outside the process that the timer is armed, and at what cadence.
2. Per invocation that expired something, one `info` line `Reservation sweep completed` carrying
   `{ correlationId, scanned, expired, skipped, durationMs, batches }`. A sweep that found no
   candidates returns early — before opening a transaction — at `debug`, as does one whose
   every candidate another writer had already handled.
3. One `inventory.stock.released` event **per hold**, carrying that hold's `cartId` and
   `reservationId` and `reason: 'expired'`. Events are never coalesced per variant, because
   coalescing would have to null exactly the two ids that make the event traceable.
4. One negative `release` row in `stock_movement` per hold, with `reason_code = 'expired'` and
   `reference_type = 'cart'`. A timer tick writes `actor_id = NULL`; the same sweep triggered
   through `POST /api/inventory/reservations/sweep` stamps the staff principal.

Each invocation mints its own `correlationId`, so a swept release joins no customer's request
trace — `GET /api/audit/trace/:correlationId` on a sweep's id returns only the sweep's own rows.
See [ADR-038](docs/adr/038-reservation-ttl-sweep-and-bounded-batches.md).

---

## 14. Not built yet

Deliberate gaps, each with the seam already in place:

| Gap | Seam that exists |
| --- | --- |
| Free-text / JSON-path search over an event `payload` or an audit `before` / `after` | the columns are returned by `GET /api/audit/*` but no index can serve a predicate over them, so none is offered ([ADR-039](docs/adr/039-audit-and-event-store-query-surface.md)) |
| Keyset (cursor) pagination for deep offsets over `domain_event` | `clampPageWindow` bounds the page, not the offset; `skip((page - 1) * size)` still walks the skipped rows ([ADR-039](docs/adr/039-audit-and-event-store-query-surface.md)) |
| Reservation retention / purge of `expired` rows | the sweep flips a hold to `expired` and leaves the row; the `(status, expires_at)` index that finds the sweep's candidates would find a purge's, and `stock_movement` already carries the release trail ([ADR-038](docs/adr/038-reservation-ttl-sweep-and-bounded-batches.md)) |
| Event retention / purge / event-sourced replay | `ris_eventstore` is a separate, independently truncatable database ([ADR-034](docs/adr/034-isolated-eventstore-database.md)) and `domain_event` stores every `payload` verbatim — but `append` is the only mutating verb on either log's port, so nothing can delete a row |
| Delivery-row purge worker | `RETENTION_DELIVERY_DAYS` is Joi-validated; nothing reads it yet |
| Real payment processor, partial captures, a gateway `fail` outcome | `PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter` |
| ESP webhook ingestion (signature verification, provider-payload mapping) | `notification.delivery.record-outcome` RPC, no HTTP route |
| Email / webhook notifier transports | `NOTIFIER` port; `LogNotifierAdapter` is the default binding |
| Locale resolution | producer events ship `customerLocale: null` |
| Tax rates and jurisdictions | `TaxCategory` is a label only |
| Media upload pipeline | `MediaAsset.uri` is an opaque, already-uploaded reference |
| Category archive / rename endpoints, cached category tree | reserved `catalogCategory*` cache builders |
| Catalog / pricing cache-aside | reserved key builders, no `CacheModule` import |
| Multi-tenancy | `t:<tenantId>` cache-key segment, opt-in |
| Transactional outbox | dual-publish is best-effort; the firehose absorbs redelivery idempotently |

---

## 15. Documentation map

| Where | What it holds |
| --- | --- |
| [`docs/adr/`](docs/adr/) | The durable rationale — one decision per file, Nygard hybrid (Status, Context, Decision, Alternatives, Consequences). Start at [`index.md`](docs/adr/index.md). Numbering and slug rules are themselves an ADR ([003](docs/adr/003-record-architecture-decisions.md)). |
| [`docs/implementation/`](docs/implementation/) | Per-capability walkthroughs, numbered by delivery order — the "how and why this specific thing works" notes an ADR is too coarse for. |
| [`docs/audits/`](docs/audits/) | Point-in-time review findings. |
| `eslint.config.mjs` | The authoritative answer to "where does this file belong". |
| The `*RpcExceptionFilter` of each module | The authoritative error-code → HTTP-status tables. |

When you make an architectural decision, **write an ADR** — next free 3-digit number,
allocated at first commit. If a decision is later reversed, write a new ADR that
**supersedes** the old one; do not edit the old one in place beyond flipping its `Status` and
adding a pointer.
