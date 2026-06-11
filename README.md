# Retail Inventory System

A microservices-based retail inventory management API built with NestJS, RabbitMQ, and MySQL.

## Architecture

Every service follows a per-module **hexagonal layout** (ports & adapters): `domain/` holds framework-free aggregates and value objects; `application/` holds use cases and the port interfaces they depend on; `infrastructure/` holds the concrete adapters (TypeORM repositories, RabbitMQ clients, Redis cache, etc.); `presentation/` holds HTTP controllers and `@MessagePattern` handlers. The boundaries are enforced by `eslint-plugin-boundaries` ([ADR-017](docs/adr/017-architecture-lint-via-eslint-boundaries.md)) — `yarn lint` is the source of truth for where a file should live.

The durable architectural artefacts are this `README.md` and the ADRs under [`docs/adr/`](docs/adr/). See [`docs/adr/index.md`](docs/adr/index.md) for the catalogue index (one row per ADR with status, date, and a one-line summary).

## Overview

The system handles order lifecycle management and product stock tracking across a distributed architecture. Clients interact with a single HTTP API gateway, which delegates work to specialized microservices over RabbitMQ.

### System diagram

```
┌───────────────────────────────────────────────────────────┐
│                       Client (HTTP)                       │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                  API Gateway port: 3000                   │
│                                                           │
│  Staff auth                                               │
│  POST  /api/auth/staff/login                              │
│  POST  /api/auth/login           (deprecated alias)       │
│  POST  /api/auth/refresh                                  │
│  POST  /api/auth/logout                                   │
│  GET   /api/auth/me                                       │
│  GET   /api/auth/admin/ping                               │
│                                                           │
│  Customer auth                                            │
│  POST  /api/auth/customer/register                        │
│  POST  /api/auth/customer/login                           │
│  POST  /api/auth/customer/guest-session                       │
│  GET   /api/auth/customer/me                              │
│                                                           │
│  IAM admin                                                │
│  GET   /api/iam/roles                                     │
│  POST  /api/iam/roles                                     │
│  PATCH /api/iam/roles/:id                                 │
│  POST  /api/iam/staff/:id/roles                           │
│  DELETE /api/iam/staff/:id/roles/:roleName                │
│                                                           │
│  Catalog (write: bearer + permission, read: public)       │
│  POST  /api/catalog/products                              │
│  POST  /api/catalog/products/:id/variants                 │
│  POST  /api/catalog/products/:id/publish                  │
│  POST  /api/catalog/products/:id/archive                  │
│  GET   /api/catalog/products                              │
│  GET   /api/catalog/products/:slug                        │
│  GET   /api/catalog/variants/:id                          │
│  POST  /api/catalog/variants/:id/prices                   │
│  GET   /api/catalog/variants/:id/prices                   │
│  GET   /api/catalog/variants/:id/price                    │
│  POST  /api/catalog/tax-categories                        │
│  GET   /api/catalog/tax-categories                        │
│  PATCH /api/catalog/variants/:id/tax-category             │
│                                                           │
│  Inventory (locations: bearer + inventory:read,           │
│             variant stock: public,                        │
│             receive/adjust: bearer + inventory:adjust)    │
│  GET   /api/inventory/locations                           │
│  GET   /api/inventory/variants/:id/stock                  │
│  POST  /api/inventory/variants/:id/stock/receive          │
│  POST  /api/inventory/variants/:id/stock/adjust           │
└──────────────┬──────────────────────────────┬─────────────┘
               │           RabbitMQ           │
      RPC      │                              │     RPC
┌──────────────▼─────────┐  ┌─────────────────▼─────────────┐
│  Retail Microservice   │  │    Inventory Microservice     │
│  Cart: 6 RPCs + place  │  │  RPC: stock-level.get,        │
│  + 4 events (cart).    │  │  location.list, receive,      │
│  Orders: get / list /  │  │  adjust; order.confirm (stub) │
│  capture (orders).     │  │  Consumes: variant.created    │
│  PAYMENT_GATEWAY ->    │  │  Emits: inventory.stock.low ──┼─┐
│  FakePaymentGateway.   │  │                               │ │
│  Emits retail.order.   │  │  ┌────────────┐               │ │
│  placed -> notification│  │  │   Redis    │◄──cache-aside─┤ │
└──────────────┬─────────┘  │  │ stock keys │               │ │
               │            │  └────────────┘               │ │
               │            └─────────────────┬─────────────┘ │
               │            MySQL             │               │
               └──────────────┬───────────────┘               │
                              │                               │
┌─────────────────────────────▼─────────────────────────────┐ │
│                        Shared DB                          │ │
│  staff_user / customer / role / permission                │ │
│  role_permissions / staff_user_roles                      │ │
│  stock_location / stock_level                              │ │
│  product / product_variant                                │ │
│  category / product_categories                            │ │
│  price / tax_category                                     │ │
│  cart / cart_line                                         │ │
│  order / order_line / address / payment                   │ │
└───────────────────────────────────────────────────────────┘ │
                                                              │
┌─────────────────────────────────────────────────────────────▼─┐
│              Notification Microservice (RMQ)                  │
│  Listens: inventory.stock.low + retail.order.placed           │
│  Fan-out via NotifierPort (log / email / webhook adapters)    │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│                  Catalog Microservice (RMQ)                   │
│  Binds: catalog_queue (product / variant + pricing)           │
│  Handles: product register/publish/archive, variant.create    │
│  Emits: variant.created -> inventory_queue (auto-init)        │
│         product.published / archived (reserved)               │
│  Reads: product.list, product.get, variant.get                │
│  Pricing: price.set/list/select + tax-category RPCs           │
└───────────────────────────────────────────────────────────────┘

OpenTelemetry: every service exports OTLP/HTTP spans through the
otel-collector → Jaeger UI at http://localhost:16686 (see the
"Distributed tracing" section below).
```

The catalog microservice owns the merchandisable graph as a `Product` aggregate with `ProductVariant` children. **`variantId` is the downstream backbone key, not `productId`**: every cluster that hangs off the catalog keys on the *variant* — inventory stock levels, pricing, and order/cart lines all address a concrete variant (the unit that is stocked, priced, and sold), not the product header. Inventory already keys on the variant: `stock_level.variant_id` is a real foreign key to `product_variant(id)` — the append-only `product_stock` ledger was dropped in the [ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md) rewrite. The legacy retail order tables (`order` / `order_product` / the two `*_status` lookups) have been torn down in the [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md) checkout rebuild; the order/cart lines that replace them key on the catalog `variantId` from the start. The catalog module also owns a **`Category` hierarchy** ([ADR-029](docs/adr/029-category-materialized-path-and-polymorphic-media.md)): each `category` row stores a **materialized `path`** (`/electronics/phones`) so a subtree read is one indexed `path LIKE` and an ancestry check is a pure string-prefix test, with reparenting done as a recompute-self-plus-one-transaction-bulk-rebase in the repository and cycle detection in the domain. **Two write operations are live over RabbitMQ**: `catalog.category.create` (insert a root or child category, slug-unique, parent resolved by slug) and `catalog.category.reparent` (move a category + its whole subtree, or demote it to a root — the reparent response surfaces the descendant-rewrite count). A bare `product_categories` N↔M join ships alongside (no entity yet, dormant until the reclassify operation lands), and a polymorphic `MediaAsset` is the next half of the same extension; the gateway HTTP surface for these RPCs is also later work.

A sibling **`pricing`** module colocates inside the same microservice (it shares `catalog_queue` and keys on the same `variantId`). It owns two tables: `price` — an append-only-for-history, `(variantId, currency)`-scoped, time-bounded ledger where a price change is a new row plus a close of the predecessor's `[validFrom, validTo)` interval (at most one open row per scope, backstopped by a generated-column UNIQUE index) — and `tax_category`, a classification label that variants point at through the nullable `product_variant.tax_category_id` FK (`ON DELETE SET NULL`). See [ADR-026](docs/adr/026-price-append-only-ledger-and-tax-category.md). It exposes six RPCs on `catalog_queue` — three price (`catalog.price.set`, one command for both Set and Schedule distinguished by `validFrom`; `catalog.price.list`; and `catalog.price.select`, Select Applicable Price: the deterministic `(variantId, currency, asOf)` → single price, resolved priority-then-recency in the use case) and three tax-category (`catalog.tax-category.create`, `catalog.tax-category.list`, and `catalog.variant.set-tax-category`, which attaches a category to a variant by writing the `product_variant.tax_category_id` FK through a parameterized query rather than a cross-module entity import) — and emits `catalog.price.changed` / `catalog.price.scheduled`. Rates/jurisdictions and the gateway HTTP endpoints are later work.

## Shared libraries

Path-aliased TypeScript libraries under `libs/`, imported as `@retail-inventory-system/<name>`:

| Library | Purpose |
| ------- | ------- |
| `contracts` | Cross-service message and DTO contracts (plain TypeScript). Sub-areas: `microservices/` (queue/pattern/client-token/app-name enums, `ICorrelationPayload`), `retail/`, `inventory/`, `auth/` (`RoleEnum`, `PermissionCodeEnum`, `ICurrentUser`, JWT payload interfaces, `IAuditLogPublisher` port + `AUDIT_LOG_PUBLISHER` token). |
| `database` | TypeORM base — `BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy`, and `DatabaseModule.forRoot(entities)` / `DatabaseModule.forFeature(entities)`. |
| `messaging` | RabbitMQ wiring — `MessagingModule`, per-service `MicroserviceClient{Retail,Inventory,Notification}Module`, `MicroserviceClientConfiguration`, `RabbitmqClientFactory`, `ROUTING_KEYS` and `EXCHANGES` constants. |
| `cache` | Cache port + Redis adapter — `ICachePort` (`get` / `set` / `del` / `wrap` / `delByPrefix` / `singleFlight`), `CACHE_PORT` DI token, `RedisCacheAdapter` (OTel-spanned), `CacheModule` (global), `@Cacheable()` decorator, `CACHE_KEYS` registry. |
| `observability` | Pino logger (`LoggerModuleConfig` with trace-correlation hook), `CorrelationMiddleware` + `@CorrelationId()` + `CORRELATION_ID_HEADER`, OTel bootstrap (`tracer.ts` side-effect import for `main.ts`), `TraceContextInterceptor` and `MetricsModule` placeholders. |
| `ddd` | Framework-free domain building blocks — `Entity`, `AggregateRoot`, `ValueObject`, `DomainEvent`, `IRepositoryPort`. No `@nestjs/*` or TypeORM imports. |
| `common` | Framework-free utilities (`Result`, `DomainException`, pagination types `IPage` / `IPageRequest`, `Maybe` / `Nullable`). |
| `config` | `configModuleConfig` (Joi env schema). |
| `auth` | Framework-glue for JWT + RBAC: `AuthModule.forRootAsync()`, `JwtStrategy`, `JwtAuthGuard`, `RolesGuard`, `PermissionsGuard`, `@Public()`, `@Roles()`, `@RequiresPermission()`, `@CurrentUser()`. The `RoleEnum` (`admin`, `catalog-manager`, `warehouse-staff`, `order-support`) and `PermissionCodeEnum` are re-exported from `@retail-inventory-system/contracts/auth` (the source of truth — framework-free). |

## Services

| Service                     | Transport                       | Responsibility                                       |
| --------------------------- | ------------------------------- | ---------------------------------------------------- |
| `api-gateway`               | HTTP (port 3000)                | Single entry point; routes requests to microservices |
| `retail-microservice`       | RabbitMQ (`retail_queue`)       | Checkout context — the mutable `Cart`/`CartLine` (`modules/cart/`) with **full cart operations** (create/get/add/change/remove/claim over six RPCs, fronted at `/api/cart`) and the immutable `Order`/`OrderLine` + polymorphic `Address` + `Payment` (`modules/orders/`) with **Place Order** (authorize-on-place), **Capture Payment** (explicit), **Get Order**, and **List My Orders** live (`PAYMENT_GATEWAY` → `FakePaymentGatewayAdapter`) |
| `inventory-microservice`    | RabbitMQ (`inventory_queue`)    | Per-variant availability + location reads; consumes `catalog.variant.created` to auto-initialize a zeroed `StockLevel` |
| `notification-microservice` | RabbitMQ (`notification_events`) | Fan-out of `inventory.stock.low` and `retail.order.placed` to a notifier port |
| `catalog-microservice`      | RabbitMQ (`catalog_queue`)      | Home of the product / variant catalog bounded context; handles `catalog.product.register` / `catalog.variant.create` / `catalog.product.publish` / `catalog.product.archive`, serves the read queries `catalog.product.list` / `catalog.product.get` / `catalog.variant.get`, handles the category writes `catalog.category.create` / `catalog.category.reparent`, emits `catalog.variant.created` onto `inventory_queue` (consumed by the inventory auto-init), and emits `catalog.product.published` / `catalog.product.archived` onto `catalog_queue` (reserved). Also hosts the colocated **pricing** module's RPCs `catalog.price.set` / `catalog.price.list` / `catalog.price.select` / `catalog.tax-category.create` / `catalog.tax-category.list` / `catalog.variant.set-tax-category` and its events `catalog.price.changed` / `catalog.price.scheduled` |

### API Gateway layout

The API Gateway is on the per-module hexagonal layout introduced in [ADR-009](docs/adr/009-port-adapter-at-the-gateway.md):

```
apps/api-gateway/src/
├── app/app.module.ts
├── common/utils/                              # throwRpcError, etc.
├── main.ts                                    # first import: @retail-inventory-system/observability/tracer
└── modules/
    ├── catalog/                               # talks to catalog-microservice (catalog + pricing RPCs)
    │   ├── application/
    │   │   ├── ports/catalog-gateway.port.ts  # ICatalogGatewayPort + CATALOG_GATEWAY_PORT
    │   │   └── use-cases/                     # Register/AddVariant/Publish/Archive + List/GetProduct/GetVariant
    │   │                                      #   + SetPrice/ListPrices/GetApplicablePrice
    │   │                                      #   + CreateTaxCategory/ListTaxCategories/AttachVariantTaxCategory
    │   ├── infrastructure/
    │   │   └── messaging/catalog-rabbitmq.adapter.ts   # only ClientProxy holder (catalog + pricing RPCs)
    │   ├── presentation/
    │   │   ├── catalog.controller.ts          # POST/GET /api/catalog/products[/...], /variants/:id[/prices|/price|/tax-category], /tax-categories
    │   │   └── dto/                           # Register/CreateVariant/SetPrice/CreateTaxCategory/AttachTaxCategory request + ListProducts/PriceQuery query DTOs
    │   └── catalog.module.ts                  # binds CATALOG_GATEWAY_PORT -> CatalogRabbitmqAdapter
    └── inventory/                             # talks to inventory-microservice (read + write RPCs)
        ├── application/
        │   ├── ports/inventory-gateway.port.ts # IInventoryGatewayPort + INVENTORY_GATEWAY_PORT
        │   └── use-cases/                     # GetVariantStock, ListLocations, ReceiveStock, AdjustStock
        ├── infrastructure/
        │   └── messaging/inventory-rabbitmq.adapter.ts  # only ClientProxy holder (read + write RPCs)
        ├── presentation/
        │   ├── inventory.controller.ts        # GET .../locations, /variants/:id/stock; POST /variants/:id/stock/receive|adjust
        │   └── dto/                           # variant-stock-query (?locationIds), receive-stock, adjust-stock request DTOs
        └── inventory.module.ts                # binds INVENTORY_GATEWAY_PORT -> InventoryRabbitmqAdapter
```

The gateway also hosts a `modules/auth/` module (with the `StaffUser`, `Customer`, `RoleAggregate`, and `PermissionAggregate` aggregates) and a sibling `modules/iam/` module (the runtime-mutable admin shell over those aggregates). These are the only gateway modules with real `domain/` state and the only ones that own DB rows. `ClientProxy` is confined to `infrastructure/messaging/*-rabbitmq.adapter.ts`; everything else depends on the port symbol. See [ADR-010](docs/adr/010-jwt-rbac-at-the-gateway.md) and [ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md).

### Per-module hexagonal layout

The notification microservice is the **canonical per-module template**. The inventory and retail microservices follow the same shape.

```
apps/notification-microservice/src/
├── app/app.module.ts                          # imports NotificationsModule + LoggerModule
├── main.ts                                    # first import: @retail-inventory-system/observability/tracer
└── modules/notifications/
    ├── domain/
    │   ├── notification.model.ts              # ValueObject<Notification>
    │   └── notification-channel.enum.ts
    ├── application/
    │   ├── ports/notifier.port.ts             # INotifierPort + NOTIFIER symbol
    │   └── use-cases/
    │       ├── send-low-stock-alert.use-case.ts
    │       └── send-order-notification.use-case.ts
    ├── infrastructure/
    │   ├── consumers/                          # RMQ @EventPattern subscribers
    │   │   ├── inventory-events.consumer.ts    # inventory.stock.low
    │   │   └── order-events.consumer.ts        # retail.order.placed
    │   ├── delivery/                           # NOTIFIER implementations
    │   │   ├── log.notifier.adapter.ts         # default
    │   │   ├── email.notifier.adapter.ts       # scaffold (TODO)
    │   │   └── webhook.notifier.adapter.ts     # scaffold (TODO)
    │   └── notifications.module.ts             # binds NOTIFIER -> LogNotifierAdapter
    └── presentation/
        └── health.controller.ts                # @MessagePattern('notification.health.ping')
```

The service fans out two cross-service events today: `inventory.stock.low` (via `InventoryEventsConsumer` → `SendLowStockAlertUseCase`) and `retail.order.placed` (via `OrderEventsConsumer` → `SendOrderNotificationUseCase`), both arriving on `notification_events`. `LogNotifierAdapter` writes the structured notification to Pino at `info` level — useful as a development sink and as the canonical implementation. Switching to email or webhook delivery is a single `useExisting`/`useClass` rebind in `notifications.module.ts` once those adapters are implemented. The notification microservice is RMQ-only (no HTTP surface); its health check rides the same transport as the event subscribers. See [ADR-011](docs/adr/011-notifier-port-and-adapters.md).

The inventory microservice exposes a single `stock` bounded context laid out the same way:

```
apps/inventory-microservice/src/
├── app/app.module.ts                          # imports StockModule + LoggerModule + CacheModule + DatabaseModule
├── main.ts                                    # first import: @retail-inventory-system/observability/tracer
└── modules/stock/
    ├── domain/
    │   ├── stock-level.model.ts               # per-location running totals (changeOnHand; available getter; version)
    │   ├── stock-location.model.ts            # StockLocation aggregate (string PK; StockLocationTypeEnum; active flag)
    │   ├── inventory.exception.ts             # InventoryDomainException + InventoryErrorCodeEnum
    │   └── events/                            # StockReceived/Adjusted/Low + StockLevelInitialized events
    ├── application/
    │   ├── ports/
    │   │   ├── stock.repository.port.ts       # IStockRepositoryPort + STOCK_REPOSITORY symbol
    │   │   ├── stock-cache.port.ts            # IStockCachePort + STOCK_CACHE symbol (getOrLoad / withInvalidation)
    │   │   ├── stock-events.publisher.port.ts # IStockEventsPublisherPort + STOCK_EVENTS_PUBLISHER symbol
    │   │   └── transaction.port.ts            # ITransactionPort + TRANSACTION_PORT symbol (opaque ITransactionScope)
    │   └── use-cases/
    │       ├── query-availability.use-case.ts # cache-aside per-variant availability read
    │       ├── list-locations.use-case.ts     # stock-location list (uncached)
    │       ├── receive-stock.use-case.ts      # quantityOnHand += n (post-commit invalidation)
    │       ├── adjust-stock.use-case.ts       # signed delta + reasonCode (rejects below-zero → 409)
    │       └── auto-init-stock-level.use-case.ts # zero a StockLevel on catalog.variant.created
    ├── infrastructure/
    │   ├── persistence/                       # StockLevel/StockLocation entities + mappers + StockTypeormRepository + TypeormTransactionAdapter
    │   ├── cache/stock.cache.ts               # STOCK_CACHE adapter; preserves ADR-002 cache-aside contract
    │   ├── consumers/catalog-events.consumer.ts # @EventPattern catalog.variant.created → AutoInitStockLevelUseCase
    │   ├── messaging/stock-rabbitmq.publisher.ts # STOCK_EVENTS_PUBLISHER adapter (inventory_queue + notification_events)
    │   └── stock.module.ts                    # binds the four port symbols → adapters; APP_FILTER → InventoryRpcExceptionFilter
    └── presentation/
        ├── stock.controller.ts                # @MessagePattern: stock-level.get/receive/adjust, location.list, order.confirm (stub)
        └── inventory-rpc-exception.filter.ts  # maps InventoryErrorCodeEnum → HTTP status
```

The `stock` context keys everything on the catalog **`variantId`** (an opaque cross-service FK to `product_variant`), not a local product id. `StockLevel` persists running totals per `(variantId, stockLocationId)` and exposes only `changeOnHand(delta)` today (with `available = onHand − allocated − reserved` a pure getter); `StockLocation` is a first-class aggregate with a caller-assigned string PK (`default-warehouse` is auto-provisioned by the migration). Reservation, allocation, transfer, and a `StockMovement` audit ledger — together with the `version` optimistic-lock enforcement — are deferred to a later inventory-reservation capability.

`ClientProxy` lives only in `infrastructure/messaging/stock-rabbitmq.publisher.ts` (which injects both the inventory and notification clients), and the cross-service consumer subscribes via `@EventPattern` under `infrastructure/consumers/`. The `STOCK_EVENTS_PUBLISHER` symbol carries the four inventory events (`inventory.stock.{received,adjusted,low}` + `inventory.stock-level.initialized`); the `inventory.order.confirm` handler is a kept-but-deprecated `RpcException` stub (stock reservation moves to the later inventory-reservation capability). See [ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md) (which supersedes [ADR-012](docs/adr/012-stock-aggregate-and-port-adapter.md)) for the `StockLevel` / `StockLocation` aggregate boundaries.

The retail microservice hosts the **mutable side of the rebuilt checkout**: the `cart` bounded-context module. Its first-generation `orders` model — a single `Order` aggregate that expanded each line into one `order_product` row per unit, a two-value status, and a cross-service `inventory.order.confirm` reserve call — was torn down in the [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md) checkout rebuild. The `Cart` aggregate root (a caller-assigned `CHAR(36)` UUID id, generated in-app) owns its `CartLine` children; the status machine is `active → converted` (placement) / `active → abandoned` (purge), both terminal. Each mutator (`addLine` increments an existing line rather than duplicating it; `changeLineQuantity` rejects `0`; `removeLine`; `markConverted`; `markAbandoned`) advances a `version` optimistic-concurrency token — shipped now though its guard is a later capability — and records a framework-free domain event. A `CartLine` snapshots its unit price (in minor units) and currency at add-time, so a sibling line's change never re-prices it; `variantId` is the opaque catalog backbone key. The `cart` / `cart_line` tables FK onto the gateway `customer` and the catalog `product_variant` in the one shared database.

The cart's **six operations** run end to end: `CreateCart` / `GetCart` / `AddToCart` / `ChangeCartLineQuantity` / `RemoveFromCart` / `ClaimCart`, served by the retail `cart.controller.ts` (`@MessagePattern` handlers on `retail_queue`) and fronted by the gateway `modules/cart/` over HTTP at `/api/cart`. **Add-to-Cart snapshots the applicable price**: it calls the catalog `catalog.price.select` RPC (through `ICartCatalogGatewayPort`) in the cart's currency and rejects an unknown/unpriced variant with a `409`, so a line always carries a real price. Authorization is **bearer plus an owner-check, not a permission code** ([ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md) / ADR-028): the gateway folds the authenticated `@CurrentUser().id` into every command and the retail use case enforces `cart.customerId === customerId`, so a customer can only touch its own cart — a non-owner gets `403`, an unauthenticated caller `401`. Each mutation emits its reserved-surface `retail.cart.*` event onto `retail_queue` (best-effort, no consumer bound yet). **Guest carts** (Q1/Q7): `POST /auth/customer/guest-session` mints a real `status='guest'` Customer with a null password and a customer-tier token — the guest-tier token replaces a session cookie, so a guest builds a cart through the same bearer-protected routes; `POST /api/cart/:cartId/claim` then promotes a guest cart to a registered customer, re-pointing it only if the supplied `fromCustomerId` (the guest id, the ownership proof) matches the cart's current owner.

It also hosts the **immutable side**: the `orders` module's `Order` aggregate (a DB-assigned `BIGINT` id) owning its `OrderLine` children, plus the polymorphic `Address` aggregate (a caller-assigned `CHAR(36)` UUID) in the same module. An `Order` carries **three orthogonal status axes** — `status`, `paymentStatus`, `fulfillmentStatus` — that evolve independently (a `captured` payment can coexist with `unfulfilled` fulfillment), rather than one combined enum. `Order.place(...)` snapshots the cart's lines into immutable `OrderLine`s (each `Object.freeze`-d, carrying a `sku`/`nameSnapshot`/`unitPriceMinor` snapshot in minor units) and derives the five money totals (`grandTotal = subtotal = Σ line totals`; tax/discount/shipping are `0` this capability); payment-axis mutators walk `none → authorized → captured`. `order.order_number` is a human-facing `ORD-<year>-<8-digit>` label finalized from the generated id (UNIQUE-backed); `order.source_cart_id` links the converted cart for repeat-place idempotency; `order.customer_id` is nullable (a deleted customer leaves a tombstone). An `Address` is **polymorphic** over `ownerType ∈ {customer, order}`; an order's billing/shipping addresses are immutable `ownerType=order` **snapshot copies**, never references into a future customer address book. A `Payment` aggregate is a **sibling in the same module** (it lives there because its operations touch `Order`): `Payment.authorized(...)` opens a row `AUTHORIZED` from a successful gateway authorize, and its single `capture(at)` mutation walks `AUTHORIZED → CAPTURED`. Payment authorization runs behind a `PAYMENT_GATEWAY` port whose default binding is a `FakePaymentGatewayAdapter` — an in-process stand-in that **always approves** with deterministic `fake_<uuid>` tokens (a real processor is an excluded capability; the port keeps the later place/capture use cases gateway-agnostic, the `NotifierPort` pattern of [ADR-011](docs/adr/011-notifier-port-and-adapters.md)).

**Place Order is live.** `POST /api/cart/:cartId/place` converts an `active` cart into an immutable `Order` one-shot: `PlaceOrderUseCase` snapshots each line from the catalog at write-time (`sku`/`nameSnapshot` via `catalog.variant.get`, `unitPriceMinor` via `catalog.price.select` — a line with no applicable price is rejected `409`), snapshots the billing + shipping addresses from the request body as immutable `ownerType=order` copies, marks the cart `converted`, and authorizes payment inline through the `PAYMENT_GATEWAY` (`AuthorizePaymentUseCase` — authorize-on-place). The order, its lines, both addresses, and the cart conversion commit in one transaction (an `orders` `TRANSACTION_PORT`, mirroring the inventory `modules/stock` adapter); the out-of-process gateway authorize and the `Payment` persist run in a short follow-up transaction. The route is bearer-protected with the same retail-side owner-check as the cart routes, and the `Idempotency-Key` header is **accepted + logged but not deduped** — repeat-place safety comes from cart state (a placed cart is `converted`; re-placing returns the order it converted into via `source_cart_id`). On success it returns the `OrderView` (`status=pending`, `paymentStatus=authorized`, `fulfillmentStatus=unfulfilled`, the line snapshots, and the authorized `payment`) and emits `retail.order.placed` (→ `notification_events`) + `retail.payment.authorized` (→ `retail_queue`) best-effort post-commit.

**Capture, Get Order, and List My Orders are live** behind the gateway `modules/orders/` (over HTTP at `/api/orders`). **Capture** (`POST /api/orders/:orderId/payments/capture`) is the explicit second half of the authorize-then-capture policy ([Q5](docs/implementation/05-cart-order-payment-walking-skeleton/07-authorize-on-place-capture-explicit-q5.md)): `CapturePaymentUseCase` calls `PAYMENT_GATEWAY.capture` out of transaction, then advances the `Payment` (`authorized → captured`) and the order's payment axis (`Order.markPaymentCaptured()`) in a short follow-up transaction, and emits `retail.payment.captured`. Re-capturing an already-captured payment returns the current state (idempotent by payment state). **Get Order** (`GET /api/orders/:orderId`) and **List My Orders** (`GET /api/orders`, own-only, paginated, newest-first) are the read paths. **Authorization on all three is bearer + owner-check with a staff override** ([ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md) / [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md)): a customer reaches only its own order, while a staff `order:read` / `order:capture` permission is an *override* that reaches any order — a permission code is never a gate on the owning customer (who carries no permissions). A non-owner non-staff caller gets `403`; an unauthenticated caller `401`.

```
apps/retail-microservice/src/
├── app/app.module.ts                          # ConfigModule + LoggerModule + DatabaseModule.forRoot([...cartEntities, ...orderEntities]) + CartModule + OrdersModule
├── modules/cart/
│   ├── domain/                                # Cart + CartLine aggregate, events, CartDomainException
│   ├── application/
│   │   ├── ports/                             # CART_REPOSITORY / CART_CATALOG_GATEWAY / CART_EVENTS_PUBLISHER
│   │   └── use-cases/                         # CreateCart/GetCart/AddToCart/Change/Remove/ClaimCart (+ loadOwnedCart owner-check)
│   ├── infrastructure/
│   │   ├── persistence/                       # cart/cart_line entities, mappers, CartTypeormRepository
│   │   ├── messaging/                         # cart-catalog.rabbitmq.adapter (price.select) + cart-rabbitmq.publisher (4 events)
│   │   └── cart.module.ts                     # forFeature + catalog/retail clients + repository/adapter/publisher/controller + APP_FILTER
│   └── presentation/                          # cart.controller (6 @MessagePattern) + cart-rpc-exception.filter
├── modules/orders/
│   ├── domain/                                # Order + OrderLine + polymorphic Address + Payment aggregates, OrderDomainException
│   ├── application/ports/                     # IOrderRepositoryPort / IAddressRepositoryPort / IPaymentRepositoryPort + IPaymentGatewayPort (PAYMENT_GATEWAY)
│   └── infrastructure/
│       ├── persistence/                       # order/order_line/address/payment entities, mappers, Order/Address/Payment TypeormRepository
│       ├── payment-gateway/                   # FakePaymentGatewayAdapter (default PAYMENT_GATEWAY — always approves, fake tokens)
│       └── orders.module.ts                   # DatabaseModule.forFeature + the three repository bindings + PAYMENT_GATEWAY → FakePaymentGatewayAdapter
└── main.ts                                    # first import: @retail-inventory-system/observability/tracer
```

See [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md) for the full target aggregate boundaries (the cart, order, payment, and address chain).

## Getting Started

Start the infrastructure and all services:

```bash
docker-compose up -d mysql redis rabbitmq
yarn migration:run
yarn start:dev
```

## Scripts

### Development

| Script | Description |
| ------ | ----------- |
| `yarn start:dev` | Start all five services concurrently with watch reload (uses `scripts/bash/start-dev.sh`). |
| `yarn start:dev:api-gateway` | Start the API gateway with watch reload. |
| `yarn start:dev:inventory-microservice` | Start the inventory microservice with watch reload. |
| `yarn start:dev:retail-microservice` | Start the retail microservice with watch reload. |
| `yarn start:dev:notification-microservice` | Start the notification microservice with watch reload. |
| `yarn start:dev:catalog-microservice` | Start the catalog microservice with watch reload. |
| `yarn start:prod:<service>` | Run a built service from `dist/` (`api-gateway`, `inventory-microservice`, `retail-microservice`, `notification-microservice`, `catalog-microservice`). |

### Build

| Script | Description |
| ------ | ----------- |
| `yarn build` | Build all five apps via `nest build --all`. |
| `yarn build:<service>` | Build a single app — same five service names as above. |

### Lint / format

| Script | Description |
| ------ | ----------- |
| `yarn lint` | Full ESLint pass, includes `boundaries/*` and runs with `--max-warnings 0` (CI gate). |
| `yarn lint:fix` | Auto-fix what can be auto-fixed (prettier, sortable imports, etc.). |
| `yarn format` | Run prettier in write mode across `apps/**/*.ts` and `libs/**/*.ts`. |
| `yarn format:check` | Run prettier in check-only mode (CI gate). |

### Database migrations

| Script | Description |
| ------ | ----------- |
| `yarn migration:create` | Scaffold a new migration file under `migrations/` (uses `scripts/migration-create.ts`). |
| `yarn migration:run` | Apply every pending migration via the TypeORM CLI. |
| `yarn migration:revert` | Revert the last applied migration. |
| `yarn migration:show` | List every migration with its applied/pending status. |
| `yarn typeorm:migration-cli` | Raw TypeORM CLI hook used by the three commands above (pre-wired with the data-source config). |

### Testing

| Script | Description |
| ------ | ----------- |
| `yarn test:unit` | Run the Jest unit suite (`jest.unit.config.js`). |
| `yarn test:e2e` | Run `test:infra:reload` then the full E2E suite against a clean database. |
| `yarn test:e2e:run` | Run the E2E suite only — assumes infra is already up. |
| `yarn test:infra:up` | Start the MySQL / Redis / RabbitMQ containers and wait for them to be healthy. |
| `yarn test:infra:down` | Stop and remove the test infra containers (drops volumes and orphans). |
| `yarn test:infra:reload` | Tear down then recreate test infra, run migrations, and seed the database. |
| `yarn test:seed` | Seed the database with deterministic fixtures from `scripts/test-db-seed.ts`. |

### Architecture lint

The per-module hexagonal layout (`domain` → `application` → `infrastructure`/`presentation`, plus the `libs/*` boundaries documented in [ADR-017](docs/adr/017-architecture-lint-via-eslint-boundaries.md)) is enforced by `eslint-plugin-boundaries`. The rules live in `eslint.config.mjs` and are the **source of truth for where a file should live** — when in doubt, run `yarn lint` and let the plugin answer.

```bash
yarn lint              # full ESLint pass, includes boundaries/* (CI gate)
yarn lint:fix          # auto-fix what can be auto-fixed (prettier, etc.)
```

What the boundaries rules cover today:

- `domain/` may import only `@retail-inventory-system/ddd`, `lib-common`, and `lib-contracts` (enums/types). No `@nestjs/*`, no TypeORM, no Redis, no AMQP, no logging.
- `application/use-cases/` may import its own module's `domain`, `application/ports`, `application/dto`, plus the same lib set as domain — plus `lib-auth` for port interfaces. Concrete adapters and `@nestjs/cache-manager`/`@keyv/redis`/`@nestjs/typeorm` imports are rejected.
- `application/ports/` may import only `domain` types and `lib-contracts`. (The previous `ARCH-LINT-EX-01` exception in `apps/inventory-microservice/.../stock.repository.port.ts` is **closed**: `ITransactionPort` now hides TypeORM's `EntityManager` behind an opaque `ITransactionScope`, and the `application-use-case` denylist tightened to forbid both `@nestjs/typeorm` and bare `typeorm`. See [ADR-017](docs/adr/017-architecture-lint-via-eslint-boundaries.md) §6.)
- `infrastructure/` is the only layer allowed to touch concrete adapters (`typeorm`, `@keyv/redis`, `amqplib`, etc.).
- `presentation/` may import `application` layers + `lib-{auth,contracts,messaging,observability}`. Direct TypeORM repositories and Redis clients are rejected.
- `libs/contracts/` is plain TypeScript (`class-validator`, `class-transformer`, and `@nestjs/swagger` are the documented exceptions for HTTP/RPC DTOs).
- `libs/ddd/` is framework-free (no `@nestjs/*`, no TypeORM, no I/O packages).
- Cross-service (`apps/X` → `apps/Y`) and cross-module imports are rejected by `boundaries/dependencies` via the `{{from.captured.app}}` / `{{from.captured.module}}` template-matched selectors.

The rules are regression-tested in `spec/architecture-lint.spec.ts` — every rule has a fixture that intentionally violates it and asserts the expected `boundaries/*` ruleId fires, so silent weakening of a rule fails the unit suite. The suite covers the inventory `stock` module, the gateway `auth`/`iam` modules, and the catalog microservice's `catalog` module.

## API

### Catalog

```
POST  /api/catalog/products                       # bearer + catalog:write
POST  /api/catalog/products/:productId/variants   # bearer + catalog:write
POST  /api/catalog/products/:productId/publish    # bearer + catalog:publish
POST  /api/catalog/products/:productId/archive    # bearer + catalog:write
GET   /api/catalog/products                        # public  — paged active-catalogue browse
GET   /api/catalog/products/:slug                  # public  — product + active variants
GET   /api/catalog/variants/:variantId             # public  — variant + parent product

# Pricing + tax categories (fronts the colocated pricing RPCs on catalog_queue)
POST  /api/catalog/variants/:variantId/prices         # bearer + pricing:write  — set or schedule a price
GET   /api/catalog/variants/:variantId/prices         # public  — prices in effect at ?asOf (?currency=USD)
GET   /api/catalog/variants/:variantId/price          # public  — single applicable price (or null body)
POST  /api/catalog/tax-categories                     # bearer + pricing:write  — create a tax category
GET   /api/catalog/tax-categories                     # public  — list tax categories
PATCH /api/catalog/variants/:variantId/tax-category   # bearer + pricing:write  — attach a tax category by code
```

The publish route enforces an **active-price precondition**: it `409`s (`PRODUCT_PUBLISH_REQUIRES_PRICE`) unless *every* variant has an in-effect price in the configured currency. That currency is an environment variable read by the catalog microservice:

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `DEFAULT_CURRENCY` | `USD` | ISO-4217 currency the catalog publish precondition resolves against (Joi-validated `length(3).uppercase()`). A product publishes only when each variant has a price in this currency. |

### Inventory

```
GET  /api/inventory/locations                         # bearer + inventory:read   — list stock locations (?activeOnly)
GET  /api/inventory/variants/:variantId/stock         # public  — per-location availability + totals (?locationIds=a,b)
POST /api/inventory/variants/:variantId/stock/receive # bearer + inventory:adjust — raise on-hand { stockLocationId?, quantity }
POST /api/inventory/variants/:variantId/stock/adjust  # bearer + inventory:adjust — signed delta { stockLocationId?, quantityDelta, reasonCode }
```

The variant-stock read is **cache-aside** (Redis): the `VariantStockView` response (per-location `StockLevelView` rows + cross-location `totalOnHand` / `totalAvailable`) is cached under `ris:inventory:stock:v2:<variantId>:<facet>`. Omitting `?locationIds` aggregates across all stock locations (the comma-separated facet is `__all__`); passing a subset scopes the answer. A variant with no stock rows is a `200` zero-availability answer (`locations: []`), not a 404. The migration provisions a `default-warehouse` location and the seed (`scripts/seeds/stock-level.sql`) gives every seeded catalog variant 100 on hand there, so the public read returns a real figure out of the box.

The two **write** routes are staff-only (`inventory:adjust`). **Receive** raises `quantityOnHand` by a positive `quantity`; **Adjust** applies a signed `quantityDelta` with a mandatory `reasonCode` and rejects a result below zero with a `409`. Both default `stockLocationId` to `default-warehouse` when omitted, return the updated single-location `StockLevelView`, invalidate the cached availability **post-commit** (ADR-023), lazy-init a missing `StockLevel`, and emit a reserved-surface event (`inventory.stock.received` / `inventory.stock.adjusted`); Adjust also re-fires `inventory.stock.low` (→ notification) when the post-commit on-hand falls at/below the threshold. **No `StockMovement`/audit row is written yet** — the `reasonCode` lives on the event + logs until the audit-log capability lands.

### Auth

```
# Staff
POST /api/auth/staff/login              # public
POST /api/auth/login                    # public — deprecated alias of /auth/staff/login
POST /api/auth/refresh                  # public
POST /api/auth/logout                   # bearer
GET  /api/auth/me                       # bearer
GET  /api/auth/admin/ping               # bearer + audit:read permission (smoke endpoint)

# Customer
POST /api/auth/customer/register        # public
POST /api/auth/customer/login           # public
POST /api/auth/customer/guest-session   # public — mints a guest-tier token + customerId
GET  /api/auth/customer/me              # bearer

# Cart  (bearer + owner-check; no permission code — a customer touches only its own cart)
POST   /api/cart                        # bearer — open a cart
GET    /api/cart/:cartId                # bearer + owner-check
POST   /api/cart/:cartId/lines          # bearer + owner-check — add a priced line
PATCH  /api/cart/:cartId/lines/:lineId  # bearer + owner-check — change quantity
DELETE /api/cart/:cartId/lines/:lineId  # bearer + owner-check — remove a line
POST   /api/cart/:cartId/claim          # bearer — promote a guest cart (fromCustomerId proof)
POST   /api/cart/:cartId/place          # bearer + owner-check — place order (authorize-on-place; Idempotency-Key header)

# Orders (read + capture)
GET    /api/orders                       # bearer — own orders, paginated, newest-first
GET    /api/orders/:orderId              # bearer — owner OR staff order:read
POST   /api/orders/:orderId/payments/capture  # bearer — owner OR staff order:capture (Idempotency-Key header)

# IAM admin
GET   /api/iam/roles                    # bearer + iam:role-edit
POST  /api/iam/roles                    # bearer + iam:role-edit
PATCH /api/iam/roles/:id                # bearer + iam:role-edit
POST  /api/iam/staff/:id/roles          # bearer + iam:assign
DELETE /api/iam/staff/:id/roles/:roleName # bearer + iam:assign
```

Interactive API reference is available at `http://localhost:3000/api/reference` when the gateway is running.

### Payment gateway

Payment authorization (on `POST /api/cart/:cartId/place`) and capture (on `POST /api/orders/:orderId/payments/capture`) run behind a **port and adapter**, never a transport call inline in a use case. The port is `IPaymentGatewayPort` (DI symbol `PAYMENT_GATEWAY`), declared in the retail `orders` module's `application/ports/`; it exposes `authorize(req)` and `capture(gatewayReference)` over plain request/result interfaces and imports **no** transport or HTTP package — the seam keeps `PlaceOrderUseCase` / `CapturePaymentUseCase` gateway-agnostic and unit-testable, the same `NotifierPort` shape as the notification microservice ([ADR-011](docs/adr/011-notifier-port-and-adapters.md)).

The default binding is `FakePaymentGatewayAdapter` (`infrastructure/payment-gateway/`): an in-process stand-in that **always approves**, mints deterministic `fake_<uuid>` gateway references (each authorize a distinct one, so the unique `payment.gateway_reference` column is satisfied), and makes no external call or persistence of its own. It exists so the whole checkout walking skeleton runs end to end without a real processor.

Swapping in a real gateway (Stripe, Adyen, …) is a **single provider rebind** in `orders.module.ts` (`{ provide: PAYMENT_GATEWAY, useClass: StripePaymentGatewayAdapter }`) plus a new HTTP-doing sibling adapter under `infrastructure/payment-gateway/` that implements the same port. No use case, controller, domain model, or contract changes — the `ClientProxy`/HTTP client stays confined to the new adapter, exactly as the boundaries rules ([ADR-017](docs/adr/017-architecture-lint-via-eslint-boundaries.md)) require. A real processor, partial captures, and void/refund/fail are deliberately excluded from this capability.

## Authentication

Every gateway route is **protected by default** by a global guard pipeline: `JwtAuthGuard` (presence + signature), `RolesGuard` (role-bundle gating via `@Roles(...)`), and `PermissionsGuard` (precise per-code gating via `@RequiresPermission(...)`). Routes opt out of the first guard with `@Public()` (today: `/auth/staff/login`, `/auth/login`, `/auth/refresh`, `/auth/customer/register`, `/auth/customer/login`, `/auth/customer/guest-session` (the single guest-bootstrap exception), the public `GET /api/catalog/...` browse/resolve and price/tax-category read routes, and the public `GET /api/inventory/variants/:variantId/stock` availability read). The `/api/cart/...` routes are bearer-protected but carry **no permission code** — authorization is an owner-check (`cart.customerId === @CurrentUser().id`), enforced retail-side, since customer tokens hold no permissions ([ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md) / [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md)). See [ADR-010](docs/adr/010-jwt-rbac-at-the-gateway.md) for the original two-guard design and [ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md) for the StaffUser/Customer split and the third guard.

Two subject kinds share the JWT pipeline:

- **`StaffUser`** — operators with one or more `Role`s, each binding a set of `Permission` codes. The access token's `permissions: string[]` claim is the union of those codes, inflated at login/refresh.
- **`Customer`** — buyer-side identity. No roles, no `permissions` claim — customer tokens never satisfy any `@RequiresPermission(...)` gate, by design.

### Login + refresh flow

```
1. POST /api/auth/staff/login { email, password }       # or /auth/customer/login
   ↳ verify password (argon2id)
   ↳ load roles → flatten permission codes (staff only)
   ↳ issue access JWT      (HS256, 15m by default, secret = JWT_ACCESS_SECRET,
                            payload includes roles + permissions for staff)
   ↳ issue refresh JWT     (HS256, 7d  by default, secret = JWT_REFRESH_SECRET)
   ↳ store argon2id hash of refresh JWT on the subject row
   ↳ return { accessToken, refreshToken, expiresIn }

2. POST /api/auth/refresh { refreshToken }
   ↳ verify signature + expiry
   ↳ argon2.verify(stored hash, presented token)
       ↳ mismatch ⇒ rotation reuse: clear the stored hash + 401
   ↳ re-inflate the staff permissions claim (so role-edits via /iam propagate)
   ↳ issue new access + refresh JWTs
   ↳ store new hash on the subject row
   ↳ return { accessToken, refreshToken, expiresIn }

3. POST /api/auth/logout (bearer)
   ↳ clear the subject's refresh-hash; subsequent /auth/refresh fails 401.
```

Refresh tokens **rotate on every successful refresh** — the old token is invalidated by hash replacement, and reuse trips a circuit-breaker that clears the live hash entirely. Permission edits made via the IAM admin endpoints take effect on the next refresh (≤15m by default); access tokens already in circulation continue to carry the pre-edit `permissions` claim.

### Roles and permissions

Roles are stored relationally in the `role` table and bound to permission codes through the `role_permissions` join. Staff users acquire roles through `staff_user_roles`. Permission codes themselves are the source-of-truth `PermissionCodeEnum` in [`libs/contracts/auth/permission.enum.ts`](libs/contracts/auth/permission.enum.ts); the four seeded role bundles live in `scripts/test-db-seed.ts` and are recreated by `yarn test:seed`.

| Role | Permission codes |
| --- | --- |
| `admin` | every code |
| `catalog-manager` | `catalog:read`, `catalog:write`, `catalog:publish`, `pricing:write` |
| `warehouse-staff` | `inventory:read`, `inventory:adjust`, `inventory:transfer` |
| `order-support` | `order:read`, `order:capture`, `order:cancel`, `order:refund` |

Guard a controller method on a precise code with `@RequiresPermission()` from `@retail-inventory-system/auth`:

```ts
@Get('roles')
@RequiresPermission(PermissionCodeEnum.IAM_ROLE_EDIT)
public list(): Promise<RoleResponseDto[]> { … }
```

`@RequiresPermission(code)` is the **precise** gate — it checks `request.user.permissions` (the JWT-inflated claim). `@Roles(RoleEnum.X, …)` remains valid for **coarse** role-bundle gating where the precise permission isn't meaningful (rare; defaults are to use `@RequiresPermission`). Customer tokens have no `permissions` claim and never satisfy `@RequiresPermission`, so any code-gated route is a staff-only path by construction. See [docs/implementation/01-baseline-identity-staffuser-customer-rbac/03-permissions-guard-and-decorator.md](docs/implementation/01-baseline-identity-staffuser-customer-rbac/03-permissions-guard-and-decorator.md) for the inflation algorithm and the staleness window.

### Permissions

Every seeded permission code and the role bundles it appears in. Codes are kebab-case `<resource>:<action>` strings; the enum is at `libs/contracts/auth/permission.enum.ts`.

| Code | Roles |
| --- | --- |
| `catalog:read` | `admin`, `catalog-manager` |
| `catalog:write` | `admin`, `catalog-manager` |
| `catalog:publish` | `admin`, `catalog-manager` |
| `inventory:read` | `admin`, `warehouse-staff` |
| `inventory:adjust` | `admin`, `warehouse-staff` |
| `inventory:transfer` | `admin`, `warehouse-staff` |
| `order:read` | `admin`, `order-support` |
| `order:capture` | `admin`, `order-support` |
| `order:cancel` | `admin`, `order-support` |
| `order:refund` | `admin`, `order-support` |
| `iam:assign` | `admin` |
| `iam:role-edit` | `admin` |
| `audit:read` | `admin` |
| `pricing:write` | `admin`, `catalog-manager` |

### Required environment variables

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `JWT_ACCESS_SECRET` | _(required, ≥ 32 chars)_ | HS256 signing key for access tokens. |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Lifetime as a `ms`-style string (`15m`, `2h`, `30s`). |
| `JWT_REFRESH_SECRET` | _(required, ≥ 32 chars; must differ from access)_ | HS256 signing key for refresh tokens. Distinct so it can be rotated independently. |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Lifetime of the refresh JWT. |
| `AUTH_ARGON2_MEMORY_COST` | `19456` (kib) | OWASP 2024 minimum for argon2id. |
| `AUTH_ARGON2_TIME_COST` | `2` | Iteration count. |
| `AUTH_ARGON2_PARALLELISM` | `1` | Threads. |

### Local development

`yarn test:seed` (or `yarn test:infra:reload`) inserts argon2id-hashed users — four staff (one per canonical role) and one customer:

| Email | Password | Role | Type |
| --- | --- | --- | --- |
| `admin@example.com` | `admin1234` | `admin` | StaffUser |
| `catalog@example.com` | `catalog1234` | `catalog-manager` | StaffUser |
| `warehouse@example.com` | `warehouse1234` | `warehouse-staff` | StaffUser |
| `support@example.com` | `support1234` | `order-support` | StaffUser |
| `customer@example.com` | `customer1234` | — | Customer |

The same seed loads a small **catalog + pricing** fixture so the catalog read paths and the publish precondition return seeded answers. Two products carry four variants; each variant has one open `USD` price; three tax categories exist as classification labels (none attached to a variant by default).

Catalog products → variants:

| Variant id | SKU | Product (slug) | Status |
| --- | --- | --- | --- |
| 1 | `AURORA-WARM` | `aurora-desk-lamp` | active |
| 2 | `AURORA-COOL` | `aurora-desk-lamp` | active |
| 3 | `NIMBUS-BLACK` | `nimbus-office-chair` | active |
| 4 | `NIMBUS-GREY` | `nimbus-office-chair` | active |

Tax categories (`tax_category` — labels only, no rate):

| id | Code | Name |
| --- | --- | --- |
| 1 | `STANDARD` | Standard rate |
| 2 | `REDUCED` | Reduced rate |
| 3 | `EXEMPT` | Exempt |

Prices (`price` — one open `USD` row per variant, `valid_to IS NULL`):

| Variant id | Currency | `amountMinor` | Display |
| --- | --- | --- | --- |
| 1 | `USD` | 4999 | $49.99 |
| 2 | `USD` | 4999 | $49.99 |
| 3 | `USD` | 19999 | $199.99 |
| 4 | `USD` | 19999 | $199.99 |

Stock levels (`stock_level` — seeded so the public availability read returns a real figure from a cold start):

| Variant id | Stock location | On hand | Allocated | Reserved |
| --- | --- | --- | --- | --- |
| 1 | `default-warehouse` | 100 | 0 | 0 |
| 2 | `default-warehouse` | 100 | 0 | 0 |
| 3 | `default-warehouse` | 100 | 0 | 0 |
| 4 | `default-warehouse` | 100 | 0 | 0 |

The migration ([ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md)) auto-provisions exactly one `StockLocation` — `default-warehouse` — idempotently (`INSERT ... ON DUPLICATE KEY UPDATE`), so there is always a location to read from and write to even before any seed runs. `scripts/seeds/stock-level.sql` then loads the rows above (`INSERT IGNORE`, registered after `catalog-product-variant.sql` because `stock_level.variant_id` is a foreign key to `product_variant.id`). On the live system the same zeroed row is created by the auto-init consumer when a catalog variant is first published; the seed is the cold-start stand-in that gives every seeded variant 100 on hand at `default-warehouse`.

The seed also loads one **example cart** for the seeded customer so `GET /api/cart/:cartId` returns a populated cart on a cold start (the `http/cart.http` and e2e flows build their own carts, so this row is purely a development convenience):

| Cart id | Customer | Currency | Status | Line |
| --- | --- | --- | --- | --- |
| `00000000-0000-4000-d000-000000000001` | `customer@example.com` | `USD` | `active` | variant 1 ×2 @ `4999` (snapshot) |

`scripts/seeds/cart.sql` runs last (idempotently — the cart row is `INSERT IGNORE` on its UUID, the line is a `WHERE NOT EXISTS` guarded insert on the `(cart_id, variant_id)` pair so it never collides with an e2e-built line's auto-increment id): the cart FKs the seeded `customer` (loaded by the identity pass, which the seed runs **before** the SQL fixtures), and the line FKs `product_variant` and snapshots variant 1's seeded USD price. The cart id uses the `...-d000-...` (carts) namespace, alongside the `a000` (users) / `b000` (permissions) / `c000` (roles) prefixes.

The `order:capture` permission is seeded (id `...-b000-00000000000e`) and bound to the `order-support` and `admin` roles — it is the staff override on `POST /api/orders/:orderId/payments/capture` (the owning customer needs no permission, only ownership).

Every catalog / pricing / stock / cart seed row uses a fixed id and `INSERT IGNORE`, so re-running `yarn test:seed` is idempotent (no duplicate rows, no error). Each price carries a fixed *past* `valid_from`, so `GET /api/catalog/variants/:variantId/price?currency=USD` returns the seeded row for variants 1–4 immediately after a seed.

Auth events emit Pino log lines with `userId` and `correlationId`, and (when wired) flow through the `AUDIT_LOG_PUBLISHER` port; the default binding is the in-process `NoOpAuditLogPublisher` (logs the event at `debug` under the `AuditLog` context). They are not fanned out to RabbitMQ today; if login alerts become a requirement, the notification microservice already has the consumer template ready — only an `auth.*` routing key plus a publisher binding are missing.

## Logging & Observability

All services emit structured JSON logs via [Pino](https://github.com/pinojs/pino) through `nestjs-pino`. Every log line includes a `correlationId` that ties a single client request to all log output it produces across every service.

### Format

| Environment | Format | Transport |
| --- | --- | --- |
| `NODE_ENV=production` | JSON (one object per line) | stdout |
| Any other value | Human-readable via `pino-pretty` | stdout |

Each JSON log line contains at minimum:

| Field | Description |
| --- | --- |
| `level` | Numeric severity — `20` debug, `30` info, `40` warn, `50` error |
| `time` | Unix timestamp in milliseconds |
| `app` | Service name (`api-gateway`, `retail-microservice`, etc.) |
| `context` | NestJS class that emitted the log |
| `correlationId` | Request trace ID (see below) |
| `msg` | Human-readable message |

### Correlation IDs

The `CorrelationMiddleware` runs on every inbound HTTP request at the API gateway:

1. If the request carries an `x-correlation-id` header, that value is used as-is.
2. Otherwise, a new UUID v4 is generated.

The ID is written back into the response headers and forwarded to every downstream RabbitMQ message payload. Microservices extract it from the payload and include it explicitly in every log call — no shared context required.

To trace a complete request across all services, filter by `correlationId`:

```bash
# From a log file
cat logs.json | jq 'select(.correlationId == "a1b2c3d4-e5f6-7890-abcd-ef1234567890")'

# Live from a running service (pipe stdout to jq)
yarn start:dev:retail-microservice 2>&1 | jq 'select(.correlationId == "a1b2c3d4-...")'
```

### `LOG_LEVEL` environment variable

Set `LOG_LEVEL` to override the default log level for all services.

| Value | Default environment |
| --- | --- |
| `debug` | development (`NODE_ENV` not `production`) |
| `info` | production (`NODE_ENV=production`) |

Available values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

### Sample: correlated request across services

The following shows the full log output for a `POST /api/inventory/variants/1/stock/adjust` request whose signed delta drops on-hand to at/below the low-stock threshold, fanning a `inventory.stock.low` event out to the notification service. Every line shares the same `correlationId` regardless of which process emitted it:

```json lines
{"level":30,"time":1748000000010,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","req":{"method":"POST","url":"/api/inventory/variants/1/stock/adjust"},"msg":"incoming request"}
{"level":30,"time":1748000000015,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"AdjustStockUseCase","pattern":"inventory.stock-level.adjust","msg":"Sending RPC to inventory service"}
{"level":30,"time":1748000000020,"app":"inventory-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"AdjustStockUseCase","variantId":1,"quantityDelta":-8,"reasonCode":"damage","msg":"Received RPC: adjust stock"}
{"level":30,"time":1748000000035,"app":"inventory-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"AdjustStockUseCase","variantId":1,"stockLocationId":"default-warehouse","quantityOnHand":2,"msg":"Stock adjusted"}
{"level":30,"time":1748000000037,"app":"inventory-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"AdjustStockUseCase","pattern":"inventory.stock.low","quantity":2,"threshold":5,"msg":"Emitting low-stock event"}
{"level":30,"time":1748000000045,"app":"notification-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"SendLowStockAlertUseCase","variantId":1,"quantity":2,"threshold":5,"msg":"Received event: stock low"}
{"level":30,"time":1748000000050,"app":"notification-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"SendLowStockAlertUseCase","channel":"log","msg":"Low-stock alert dispatched"}
{"level":30,"time":1748000000060,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","res":{"statusCode":200},"responseTime":50,"msg":"request completed"}
```

See [ADR-001](docs/adr/001-structured-logging-with-pino.md) for the rationale behind this design.

### Distributed tracing (OpenTelemetry + Jaeger)

In addition to correlation IDs, every service ships W3C-trace-context spans via OpenTelemetry. A single client request becomes a single trace that follows the HTTP entrypoint into the gateway and then across every RabbitMQ hop into the retail, inventory, and notification services. Every Pino log line emitted inside an active span is decorated with `traceId` and `spanId`, so logs and traces can be cross-filtered in any sink.

ADRs: [ADR-014](docs/adr/014-otel-exporter-otlp-http-and-jaeger.md) (OTLP/HTTP → collector → Jaeger), [ADR-015](docs/adr/015-pino-trace-correlation.md) (Pino `traceId`/`spanId` enrichment).

#### Required environment variables

| Var | Example | Notes |
| --- | --- | --- |
| `OTEL_SERVICE_NAME` | `api-gateway` | Distinct per service; Jaeger uses it for the "Service" filter |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4318/v1/traces` | OTLP/HTTP traces endpoint |
| `OTEL_RESOURCE_ATTRIBUTES` | `team=platform` | Optional; merged into the OTel `Resource` |
| `OTEL_SDK_DISABLED` | `false` | Set to `true` to short-circuit the SDK at boot (useful in some tests) |

In Docker Compose, the per-service `environment:` blocks already set `OTEL_SERVICE_NAME` and point `OTEL_EXPORTER_OTLP_ENDPOINT` at the in-cluster `otel-collector:4318`. For host-side `yarn start:dev`, copy `.env.example` to `.env.local` — the defaults there point at `http://localhost:4318/v1/traces`, which is where the `otel-collector` container publishes when the observability overlay is up.

#### Starting the observability stack

The Jaeger UI and the OpenTelemetry collector are kept in a **separate compose overlay** so day-to-day work doesn't pay for them:

```bash
# Bring up infra + observability together
docker compose -f docker-compose.yml -f docker-compose.observability.yml up

# Or stop just the observability containers when you're done
docker compose -f docker-compose.yml -f docker-compose.observability.yml stop jaeger otel-collector
```

| Endpoint | Purpose |
| --- | --- |
| `http://localhost:16686` | Jaeger UI — filter by service, search by trace ID |
| `http://localhost:4317` | OTLP/gRPC ingress on the collector |
| `http://localhost:4318` | OTLP/HTTP ingress on the collector (apps publish here) |

The collector config lives at [`infrastructure/otel-collector-config.yaml`](infrastructure/otel-collector-config.yaml) and is a single pipeline: OTLP receiver → `batch` processor → OTLP exporter to Jaeger (with a `debug` exporter for visibility during local development).

#### Finding a trace

1. Open Jaeger at <http://localhost:16686>.
2. Pick a service (e.g. `api-gateway`) and an operation (e.g. `POST /api/inventory/variants/:id/stock/adjust`).
3. The matching trace shows spans from every service the request touches, including the AMQP `publish` / `process` pairs that connect the gateway → inventory → notification flow.
4. To go from a log line back to the trace, copy `traceId` from any service's log and paste it into Jaeger's "Lookup by Trace ID" box.

#### The "first import in `main.ts`" rule

Every service's `main.ts` must `import '@retail-inventory-system/observability/tracer';` as its **very first import**. The tracer bootstrap registers OpenTelemetry's auto-instrumentations (HTTP, MySQL, Redis, amqplib), and those have to run before any of the patched modules are required — otherwise the instrumentation does nothing and spans are silently missing. This rule is enforced by code review today; a future eslint rule for import ordering would close the loop.

## Caching

The Inventory microservice caches **per-variant availability reads** in Redis using the **cache-aside (lazy loading)** pattern. The cached value is a `VariantStockView` — the per-location `StockLevelView` rows for a catalog **variant** plus the cross-location `totalOnHand` / `totalAvailable`. `QueryAvailabilityUseCase` orchestrates the cache-aside read; `StockCache` (the `STOCK_CACHE` adapter) is a thin domain-shaped wrapper over the generic `CACHE_PORT`; `StockTypeormRepository` materializes the answer with a **point lookup** of the variant's `stock_level` rows. The presentation-layer `StockController` and the API gateway are both unaware of the cache.

Under the previous inventory model the value was a `SUM(quantity) ... GROUP BY storageId` aggregate over an append-only `product_stock` ledger keyed on `productId`, whose cost grew linearly with movement history. The running-totals rewrite ([ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md)) keeps `quantityOnHand` / `quantityAllocated` / `quantityReserved` as maintained counters on one `stock_level` row per `(variantId, stockLocationId)`, so a read is now a constant-cost point lookup. The cache-aside **mechanism** is unchanged (ADR-002 → ADR-006 → ADR-016 → ADR-021 → ADR-022 → ADR-023); only the cached **value shape** and the **key axis** (`productId` → `variantId`) changed — which is what forced the [`v1 → v2` key-version bump](docs/implementation/04-inventory-stock-level-and-location/04-cache-key-bump-v1-to-v2.md). The full read path is documented in [the availability read path](docs/implementation/04-inventory-stock-level-and-location/07-availability-read-path.md).

The cache layer follows the conventions formalized in [ADR-016](docs/adr/016-cache-aside-generalized.md): every cache key is built via `CACHE_KEYS.*` (no string literals in `apps/*/src`), and apps depend on `ICachePort` rather than `@nestjs/cache-manager` directly.

### What is not cached

Only the per-variant availability read is cached today. The location list (`GET /api/inventory/locations` → `ListLocationsUseCase`) is **not** cached — it is a small, slow-changing set, and the gateway adds no caching of its own. The catalog browse/resolve reads and the **pricing** reads (`catalog.price.select` / `catalog.price.list` and their gateway routes) deliberately go straight to MySQL on every call — their read volume has not crossed the threshold where cache-aside complexity (key versioning plus post-commit invalidation on every price append/close) pays for itself. The key shape is already reserved for when it does: `CACHE_KEYS.catalogPrice(variantId, currency)` builds `ris:catalog:price:v1:<variantId>:<currency>` (mirroring the stock keys and the reserved `catalogProduct*` block), versioned and ready — but no catalog/pricing module imports `CacheModule` for it yet. Caching pricing reads is a later capability gated on measured read pressure, not a missing feature.

### Read flow

```
1. Client request                  → QueryAvailabilityUseCase.execute()
2. STOCK_CACHE.getOrLoad(key, loader):
     → hit?  return the cached VariantStockView, done
     → miss? run the loader (single-flighted), write-back, return
3. loader → STOCK_REPOSITORY.findStockLevelsByVariant(variantId, locationIds?)
     → point lookup of the variant's stock_level rows (no SUM/GROUP BY)
     → project each row to a StockLevelView, sort by stockLocationId, sum totals
4. STOCK_CACHE.set(key, view, jittered TTL)  → populate cache
5. Return VariantStockView                    → reply to client
```

A variant with no `stock_level` rows in scope is a valid, cached zero-availability answer (`totalOnHand: 0`, `locations: []`) rather than a 404. The read path holds no caller-owned transaction scope, so it has no skip-cache branch; the write operations that *do* mutate state (Receive / Adjust) invalidate post-commit (see Invalidation, below).

### Cache key

```
ris:inventory:stock:v2:<variantId>:__all__                         # no locationIds filter
ris:inventory:stock:v2:<variantId>:<locationIds-joined-by-comma>   # e.g. ris:inventory:stock:v2:42:backup-store,default-warehouse
```

Stock-location ids are sorted with `localeCompare` so callers passing the same set in different orders generate identical keys (`__all__` is the sentinel for an unscoped, aggregate-across-all-locations read). The `v2` segment is the per-aggregate schema-version constant (`INVENTORY_STOCK_KEY_VERSION` in `libs/cache/cache-keys.ts`); it was bumped from `v1` when the cached value reshaped from the per-product `SUM` aggregate to the per-variant `VariantStockView` projection **and** the key axis moved from `productId` to `variantId` ([ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md)) — pre-bump entries became unreachable and age out via TTL. Built by `CACHE_KEYS.inventoryStock(variantId, stockLocationIds?, opts?)`; an optional `{ tenantId }` argument prefixes the key with `t:<tenantId>:` for future multi-tenant use (omitted entirely when absent — never defaulted). Three legacy prefixes are still wiped by the SCAN-based invalidate path so a rolling deploy can sweep entries written under the pre-v2 (`ris:inventory:stock:v1:<id>:`), pre-v1 (`ris:inventory:stock:<id>:`), and pre-ADR-016 (`stock:<id>:`) conventions.

The general key convention is `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]` (see [ADR-022](docs/adr/022-cache-keys-tenant-and-schema-version.md)). `CACHE_KEYS.retailOrder(orderId)` and `CACHE_KEYS.catalogProduct(...)` follow the same shape at `v1` (no caller today; reserved for future read paths).

### TTL

| Env var                     | Default (ms) | Role                                                                 |
| --------------------------- | ------------ | -------------------------------------------------------------------- |
| `CACHE_TTL_MS_DEFAULT`      | `60000`      | Global default applied by the Cache module to any unscoped `set()`.  |
| `CACHE_TTL_MS_PRODUCT_STOCK`| `60000`      | TTL applied explicitly when caching a per-variant availability read (the env name predates the running-totals rewrite). |

TTL is a safety net, not the primary freshness mechanism — explicit invalidation is.

Per [ADR-021](docs/adr/021-cache-single-flight-and-ttl-jitter.md), `StockCache.set` applies a uniform ±10% jitter to the configured TTL before writing to Redis (so a batch of writes landing within one event-loop tick does not expire on the same wall-clock band). The jittered value is floored to the integer-ms contract of `ICachePort.set` and is always ≥ `ttl * 0.9`, so the TTL safety-net role is preserved.

### Miss-path single-flight

Per [ADR-021](docs/adr/021-cache-single-flight-and-ttl-jitter.md), concurrent cache misses on the same `(variantId, stockLocationIds)` key fan out to a single `repository.findStockLevelsByVariant` call per process. The primitive lives on `ICachePort.singleFlight(key, fn)`; `StockCache.getOrLoad` composes it with the cache-aside read+write so `QueryAvailabilityUseCase` never sees the dedupe machinery. A rejected loader propagates to every waiter (no silent retry-and-fan-out), and the in-flight slot is cleared on settlement so a failed leader does not poison the key for the next caller.

### Invalidation

The write operations `ReceiveStockUseCase` and `AdjustStockUseCase` each wrap their read-modify-write in `stockCache.withInvalidation(work, resolveItems, { correlationId })` — a callback-based helper that awaits `work()` (so the commit is durable) and only then derives the invalidation items (`resolveItems(saved)` → `{ variantId, stockLocationId }[]`) and fans out the prefix deletes. The post-commit ordering is enforced by the helper's type signature ([ADR-023](docs/adr/023-cache-invalidate-post-commit-by-type.md)): `IStockCachePort` has no public `invalidate(...)`, so a future contributor cannot accidentally call it from inside the transaction body, and a rejected `work` propagates without touching the cache.

Invalidation issues **four** `delByPrefix` calls per affected `variantId` during the transition window (the current `v2` prefix, the pre-v2 `inventoryStockLegacyPrefixV1` = `ris:inventory:stock:v1:<variantId>:`, the pre-v1 `inventoryStockLegacyPrefix`, and the pre-ADR-016 `productStockPrefix` — see [ADR-022](docs/adr/022-cache-keys-tenant-and-schema-version.md) §4). Each `delByPrefix` does `SCAN MATCH <prefix>*` and `UNLINK`s every matching key. `UNLINK` (vs `DEL`) frees memory asynchronously on the Redis side, avoiding a blocking O(N) delete on Redis's main thread.

### Tracing

Each cache call opens an OTel span (`cache.get`, `cache.set`, `cache.del`, `cache.wrap`, `cache.delByPrefix`, `cache.singleFlight`) with `cache.key`, `cache.hit`, `cache.keys_unlinked` (for prefix deletes), and `cache.singleflight.joined` (true when the call attached to an existing leader) attributes. Hits and misses are visible in Jaeger end-to-end.

### Graceful degradation

Every cache operation is wrapped in a `try/catch` that logs a `warn` and swallows the error:

- **Read failure** → returns `undefined` (the same contract as a miss); the façade falls through to the DB and the request succeeds.
- **Write failure** → swallowed; the response is still returned to the client.
- **Invalidation failure** → swallowed; the entry remains until its TTL expires.

A Redis outage degrades latency, never correctness — no path throws to the client because the cache is unavailable.

### Inspecting the cache

```bash
# List every cached availability entry across all variants
redis-cli --scan --pattern 'ris:inventory:stock:v2:*'

# Read a specific entry (variant 1, aggregated across all locations)
redis-cli GET 'ris:inventory:stock:v2:1:__all__'

# Check remaining TTL (in ms) for a key
redis-cli PTTL 'ris:inventory:stock:v2:1:__all__'

# Manually invalidate every cached entry for a single variant
redis-cli --scan --pattern 'ris:inventory:stock:v2:1:*' | xargs -r redis-cli UNLINK
```

See [ADR-002](docs/adr/002-redis-cache-aside-product-stock.md) for the original design, [ADR-016](docs/adr/016-cache-aside-generalized.md) for the generalized key convention + port-based invalidation, and [ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md) for the `StockLevel` projection the `v2` value carries.
