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
│  POST  /api/catalog/categories                            │
│  PATCH /api/catalog/categories/:slug/parent               │
│  GET   /api/catalog/categories                            │
│  GET   /api/catalog/categories/:slug/tree                 │
│  GET   /api/catalog/categories/:slug/products             │
│  POST  /api/catalog/products/:id/categories               │
│  DELETE /api/catalog/products/:id/categories/:slug        │
│  POST  /api/catalog/media                                 │
│  PATCH /api/catalog/media/reorder                         │
│  DELETE /api/catalog/media/:id                            │
│  GET   /api/catalog/products/:id/media                    │
│  GET   /api/catalog/variants/:id/media                    │
│                                                           │
│  Inventory (locations + movements: inventory:read,        │
│             variant stock: public,                        │
│             receive/adjust/release: inventory:adjust,     │
│             transfer: inventory:transfer)                 │
│  GET   /api/inventory/locations                           │
│  GET   /api/inventory/variants/:id/stock                  │
│  GET   /api/inventory/variants/:id/movements              │
│  POST  /api/inventory/variants/:id/stock/receive          │
│  POST  /api/inventory/variants/:id/stock/adjust           │
│  POST  /api/inventory/variants/:id/stock/transfer         │
│  POST  /api/inventory/reservations/:id/release            │
└──────────────┬──────────────────────────────┬─────────────┘
               │           RabbitMQ           │
      RPC      │                              │     RPC
┌──────────────▼─────────┐  ┌─────────────────▼─────────────┐
│  Retail Microservice   │  │    Inventory Microservice     │
│  Cart: 6 RPCs + place  │  │  RPC: stock-level.get,        │
│  Orders: get/list/cap. │  │  location.list, receive,      │
│  Fulfillment: create/  │  │  adjust, transfer,            │
│  ship/deliver/cancel.  │  │  stock-movement.list,         │
│  Ship captures payment │  │  reservation.reserve/release/ │
│  + commit-sale -> inv. │  │  allocate, allocation.cancel, │
│  Returns: RMA lifecycle│  │  commit-sale + restock-return │
│  -> inv restock-return │  │  Aggregates: StockLevel,      │
│  Refunds: issue/list,  │  │  StockLocation, Reservation,  │
│  auto-refund on cancel │  │  StockMovement (ledger)       │
│  Calls inv reserve/    │  │  Consumes: variant.created    │
│  release/allocate.     │  │  Emits: reserved/allocated/   │
│  Emits order/fulfill./ │  │  released/committed/returned  │
│  return/refund events  │  │  + stock.low ─────────────────┼─┐
└──────────────┬─────────┘  │  ┌────────────┐               │ │
               │            │  │   Redis    │◄──cache-aside─┤ │
               │            │  │ stock keys │               │ │
               │            │  └────────────┘               │ │
               │            └─────────────────┬─────────────┘ │
               │            MySQL             │               │
               └──────────────┬───────────────┘               │
                              │                               │
┌─────────────────────────────▼─────────────────────────────┐ │
│                        Shared DB                          │ │
│  staff_user / customer / role / permission                │ │
│  role_permissions / staff_user_roles                      │ │
│  stock_location / stock_level / reservation               │ │
│  stock_movement                                           │ │
│  product / product_variant                                │ │
│  category / product_categories / media_asset              │ │
│  price / tax_category                                     │ │
│  cart / cart_line                                         │ │
│  order / order_line / address / payment                   │ │
│  refund                                                   │ │
│  fulfillment / fulfillment_line                           │ │
│  return_request / return_line                             │ │
└───────────────────────────────────────────────────────────┘ │
                                                              │
┌─────────────────────────────────────────────────────────────▼─┐
│              Notification Microservice (RMQ)                  │
│  Tables: notification_template / notification_delivery        │
│  Listens: inventory.stock.low, retail.order.placed,           │
│  retail.fulfillment.shipped / .delivered,                     │
│  retail.return.requested / .authorized / .received /          │
│  .inspected, retail.refund.issued                             │
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

The retail microservice now drives the inventory **reservation surface** so the cart and order flows hold real stock ([ADR-030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)): the cart write path reserves on add/change and releases on remove (`inventory.reservation.reserve` / `.release`, via `CART_INVENTORY_GATEWAY`), and Place Order allocates inside the conversion transaction with a best-effort cancel-allocation compensation (`inventory.reservation.allocate` / `inventory.allocation.cancel`, via `ORDER_INVENTORY_GATEWAY`). These are retail → inventory RPCs over `inventory_queue` (no gateway HTTP route of their own); the only HTTP-visible change is that an out-of-stock add/place now returns `409 INVENTORY_OUT_OF_STOCK` carrying `details.available`.

The catalog microservice owns the merchandisable graph as a `Product` aggregate with `ProductVariant` children. **`variantId` is the downstream backbone key, not `productId`**: every cluster that hangs off the catalog keys on the *variant* — inventory stock levels, pricing, and order/cart lines all address a concrete variant (the unit that is stocked, priced, and sold), not the product header. Inventory already keys on the variant: `stock_level.variant_id` is a real foreign key to `product_variant(id)` — the append-only `product_stock` ledger was dropped in the [ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md) rewrite. The legacy retail order tables (`order` / `order_product` / the two `*_status` lookups) have been torn down in the [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md) checkout rebuild; the order/cart lines that replace them key on the catalog `variantId` from the start. The catalog module also owns a **`Category` hierarchy** ([ADR-029](docs/adr/029-category-materialized-path-and-polymorphic-media.md)): each `category` row stores a **materialized `path`** (`/electronics/phones`) so a subtree read is one indexed `path LIKE` and an ancestry check is a pure string-prefix test, with reparenting done as a recompute-self-plus-one-transaction-bulk-rebase in the repository and cycle detection in the domain. **The category surface is now RPC-complete over RabbitMQ** — two writes, three reads, and reclassify: `catalog.category.create` (insert a root or child category, slug-unique, parent resolved by slug) and `catalog.category.reparent` (move a category + its whole subtree, or demote it to a root — the reparent response surfaces the descendant-rewrite count); `catalog.category.list` (the flat navigation list, `?root` filter, ordered `sortOrder, name`, active-only), `catalog.category.get-tree` (the nested active subtree by slug — an archived intermediate hides its whole branch), and `catalog.category.list-products` (the paged active products under a category, optionally widened to its descendant subtree via the materialized-path expansion); and `catalog.product.reclassify` (a bulk attach + detach of a product's category memberships in one idempotent command — attach to an archived category is blocked, detach from one is allowed). The `product_categories` N↔M membership is a **bare join** (composite PK, no surrogate id, no entity) maintained with parameterized `INSERT IGNORE` / `DELETE` straight at the repository; none of the category operations emits an event. The same module also owns a **polymorphic `MediaAsset`** ([ADR-029](docs/adr/029-category-materialized-path-and-polymorphic-media.md)): one `media_asset` table carries images / videos / documents that hang off either a `product` or a `product-variant`, discriminated by an `owner_type` column with **no foreign key** on the polymorphic `owner_id` (the attach use case probes the owner's existence by hand; a composite `(owner_type, owner_id, sort_order)` index is the read-path compensation). The media surface is **RPC-complete over RabbitMQ**: `catalog.media.attach` (append a new asset at `max(sort_order)+1`, owner counted across active **and** archived rows so slots stay monotonic), `catalog.media.reorder` (one-transaction bulk re-sequence — the id set must be an exact permutation of the owner's active media, all-or-nothing), `catalog.media.detach` (a state-guarded `active → archived` flip — the row survives so historical references still resolve), and `catalog.media.list` (the owner's active strip, `sortOrder ASC`, an unknown owner yields `[]` not a 404). The `uri` is an **opaque, already-uploaded reference** (`https://…` / `s3://…`) — no scheme validation, no upload pipeline. None of the media operations emits an event. Media also feeds a **soft publish recommendation**: publishing a product whose product owner and every variant owner lack an active media asset still succeeds, but the publish response's `warnings[]` carries `CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA` — never a block, the deliberate contrast with the hard price gate. **The gateway now fronts the category + media RPCs over HTTP** at `/api/catalog` (twelve routes — seven category, five media; writes gated by `catalog:write`, reads `@Public()`; see [docs/implementation/06-catalog-category-and-media/05-category-and-media-api.md](docs/implementation/06-catalog-category-and-media/05-category-and-media-api.md)). The `warnings[]` field already flows over the existing publish route untouched.

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
| `retail-microservice`       | RabbitMQ (`retail_queue`)       | Checkout context — the mutable `Cart`/`CartLine` (`modules/cart/`) with **full cart operations** (create/get/add/change/remove/claim over six RPCs, fronted at `/api/cart`) and the immutable `Order`/`OrderLine` + polymorphic `Address` + `Payment` + the per-shipment `Fulfillment` (`modules/orders/`) with **Place Order** (authorize-on-place), **Capture Payment** (explicit), **Get Order**, **List My Orders**, and the full **Fulfillment** lifecycle (**Create**/**List**/**Ship**/**Deliver**) + **Cancel Order**/**Cancel Line** live (`PAYMENT_GATEWAY` → `FakePaymentGatewayAdapter`) |
| `inventory-microservice`    | RabbitMQ (`inventory_queue`)    | Per-variant availability + location reads; consumes `catalog.variant.created` to auto-initialize a zeroed `StockLevel` |
| `notification-microservice` | RabbitMQ (`notification_events`) | Fan-out of `inventory.stock.low`, `retail.order.placed`, `retail.fulfillment.shipped` / `.delivered`, the return lifecycle events `retail.return.requested` / `.authorized` / `.received` / `.inspected`, and `retail.refund.issued` to a notifier port. Owns the `notification_template` (versioned registry) + `notification_delivery` (audit trail) tables in the shared `retail_db` (ADR-033) |
| `catalog-microservice`      | RabbitMQ (`catalog_queue`)      | Home of the product / variant catalog bounded context; handles `catalog.product.register` / `catalog.variant.create` / `catalog.product.publish` / `catalog.product.archive`, serves the read queries `catalog.product.list` / `catalog.product.get` / `catalog.variant.get`, handles the category writes `catalog.category.create` / `catalog.category.reparent`, the category reads `catalog.category.list` / `catalog.category.get-tree` / `catalog.category.list-products`, the membership write `catalog.product.reclassify`, and the media operations `catalog.media.attach` / `catalog.media.reorder` / `catalog.media.detach` / `catalog.media.list`, emits `catalog.variant.created` onto `inventory_queue` (consumed by the inventory auto-init), and emits `catalog.product.published` / `catalog.product.archived` onto `catalog_queue` (reserved). Also hosts the colocated **pricing** module's RPCs `catalog.price.set` / `catalog.price.list` / `catalog.price.select` / `catalog.tax-category.create` / `catalog.tax-category.list` / `catalog.variant.set-tax-category` and its events `catalog.price.changed` / `catalog.price.scheduled` |

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
    │   │                                      #   + CreateCategory/ReparentCategory/ListCategories/GetCategoryTree/ListCategoryProducts
    │   │                                      #   + AttachProductCategories/DetachProductCategory
    │   │                                      #   + AttachMedia/ReorderMedia/DetachMedia/ListMedia
    │   ├── infrastructure/
    │   │   └── messaging/catalog-rabbitmq.adapter.ts   # only ClientProxy holder (catalog + pricing + category + media RPCs)
    │   ├── presentation/
    │   │   ├── catalog.controller.ts          # POST/GET /api/catalog/products[/...], /variants/:id[/prices|/price|/tax-category], /tax-categories
    │   │   ├── category.controller.ts         # POST/PATCH/GET/DELETE /api/catalog/categories[/...], /products/:id/categories[/:slug]
    │   │   ├── media.controller.ts            # POST/PATCH/DELETE /api/catalog/media[/...], GET /products|variants/:id/media
    │   │   └── dto/                           # Register/CreateVariant/SetPrice/CreateTaxCategory/AttachTaxCategory/CreateCategory/ReparentCategory/AttachProductCategories/AttachMedia/ReorderMedia request + ListProducts/PriceQuery/ListCategories/CategoryProducts query DTOs
    │   └── catalog.module.ts                  # binds CATALOG_GATEWAY_PORT -> CatalogRabbitmqAdapter
    └── inventory/                             # talks to inventory-microservice (read + write RPCs)
        ├── application/
        │   ├── ports/inventory-gateway.port.ts # IInventoryGatewayPort + INVENTORY_GATEWAY_PORT
        │   └── use-cases/                     # GetVariantStock, ListLocations, ListVariantMovements,
        │                                      #   ReceiveStock, AdjustStock, TransferStock, ReleaseReservation
        ├── infrastructure/
        │   └── messaging/inventory-rabbitmq.adapter.ts  # only ClientProxy holder (read + write + reservation RPCs)
        ├── presentation/
        │   ├── inventory.controller.ts        # GET .../locations, /variants/:id/stock, /variants/:id/movements;
        │   │                                  #   POST /variants/:id/stock/receive|adjust|transfer, /reservations/:id/release
        │   └── dto/                           # variant-stock-query (?locationIds), movements-query, receive-stock, adjust-stock, transfer-stock request DTOs
        └── inventory.module.ts                # binds INVENTORY_GATEWAY_PORT -> InventoryRabbitmqAdapter
```

The gateway also hosts a `modules/auth/` module (with the `StaffUser`, `Customer`, `RoleAggregate`, and `PermissionAggregate` aggregates) and a sibling `modules/iam/` module (the runtime-mutable admin shell over those aggregates). These are the only gateway modules with real `domain/` state and the only ones that own DB rows. `ClientProxy` is confined to `infrastructure/messaging/*-rabbitmq.adapter.ts`; everything else depends on the port symbol. See [ADR-010](docs/adr/010-jwt-rbac-at-the-gateway.md) and [ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md).

### Per-module hexagonal layout

The notification microservice is the **canonical per-module template**. The inventory and retail microservices follow the same shape.

```
apps/notification-microservice/src/
├── app/app.module.ts                          # imports NotificationsModule + LoggerModule + DatabaseModule.forRoot
├── main.ts                                    # first import: @retail-inventory-system/observability/tracer
└── modules/notifications/
    ├── domain/
    │   ├── notification.model.ts              # ValueObject<Notification>
    │   ├── notification-template.model.ts     # AggregateRoot — the versioned registry (ADR-033)
    │   ├── notification-delivery.model.ts     # AggregateRoot — the delivery audit trail (ADR-033)
    │   ├── notification-error-code.enum.ts    # NotificationErrorCodeEnum
    │   └── notification-domain.exception.ts   # NotificationDomainException
    ├── application/
    │   ├── ports/
    │   │   ├── notifier.port.ts               # INotifierPort + NOTIFIER symbol
    │   │   ├── template-renderer.port.ts      # ITemplateRendererPort + TEMPLATE_RENDERER symbol
    │   │   ├── notification-template.repository.port.ts   # NOTIFICATION_TEMPLATE_REPOSITORY
    │   │   └── notification-delivery.repository.port.ts   # NOTIFICATION_DELIVERY_REPOSITORY
    │   └── use-cases/
    │       ├── send-low-stock-alert.use-case.ts
    │       ├── send-order-notification.use-case.ts
    │       ├── send-shipment-notification.use-case.ts
    │       ├── send-return-notification.use-case.ts   # requested/authorized/received/inspected
    │       └── send-refund-notification.use-case.ts   # issued
    ├── infrastructure/
    │   ├── persistence/                        # the service's first DB layer (ADR-033)
    │   │   ├── notification-template.entity.ts / .mapper.ts / -typeorm.repository.ts
    │   │   ├── notification-delivery.entity.ts / .mapper.ts / -typeorm.repository.ts
    │   │   └── index.ts                         # exports notificationEntities
    │   ├── consumers/                          # RMQ @EventPattern subscribers
    │   │   ├── inventory-events.consumer.ts    # inventory.stock.low
    │   │   ├── order-events.consumer.ts        # retail.order.placed
    │   │   ├── fulfillment-events.consumer.ts  # retail.fulfillment.shipped / .delivered
    │   │   ├── return-events.consumer.ts       # retail.return.requested / .authorized / .received / .inspected
    │   │   └── refund-events.consumer.ts       # retail.refund.issued
    │   ├── delivery/                           # NOTIFIER implementations
    │   │   ├── log.notifier.adapter.ts         # default
    │   │   ├── email.notifier.adapter.ts       # scaffold (TODO)
    │   │   └── webhook.notifier.adapter.ts     # scaffold (TODO)
    │   ├── render/                             # TEMPLATE_RENDERER implementation
    │   │   └── handlebars-template-renderer.adapter.ts   # the only `handlebars` import (ADR-033)
    │   └── notifications.module.ts             # binds NOTIFIER + TEMPLATE_RENDERER + the two repo ports; DatabaseModule.forFeature
    └── presentation/
        └── health.controller.ts                # @MessagePattern('notification.health.ping')
```

The notification microservice now owns **two database tables** in the shared `retail_db`
([ADR-033](docs/adr/033-notification-templates-deliveries-and-render-dispatch.md)) — its
first persistence. `notification_template` is a versioned, per-`(eventType, channel, locale)`
registry (an edit appends a new business `version`, old rows retained for audit/rollback;
soft-delete via an `active` flag; `subject` required for `email`/`webhook`, optional for
`sms`/`push`); `notification_delivery` is the queryable audit trail of one outgoing
notification (`queued → sent → delivered/failed/bounced`, monotonic `attemptCount`,
live-ephemeral, with a STORED generated-column UNIQUE that dedupes a customer-facing
double-dispatch). Both back the `NotificationTemplate` / `NotificationDelivery` aggregates.
The **template renderer is live**: `ITemplateRendererPort` (`TEMPLATE_RENDERER`) is bound to
`HandlebarsTemplateRendererAdapter` (the only file importing `handlebars`), which compiles a
template subject/body against a render context. Handlebars is logic-light by design, and its
`{{ }}` interpolation HTML-escapes the render context by default — the right posture for
trusted, staff-authored template *source* combined with untrusted context *data* (no
`{{{ triple-stache }}}` for data). See
[docs/implementation/10-notification-templates-and-deliveries/05-handlebars-renderer-choice.md](docs/implementation/10-notification-templates-and-deliveries/05-handlebars-renderer-choice.md).
The render-and-dispatch pipeline that fronts the `NOTIFIER` (the renderer's first consumer),
the author/activate operations, and the gateway HTTP surface follow in later work. The two
repository ports and the renderer port are wired but not yet resolved by any use case.

The service fans out seven cross-service events today: `inventory.stock.low` (via `InventoryEventsConsumer` → `SendLowStockAlertUseCase`), `retail.order.placed` (via `OrderEventsConsumer` → `SendOrderNotificationUseCase`), `retail.fulfillment.shipped` / `retail.fulfillment.delivered` (via `FulfillmentEventsConsumer` → `SendShipmentNotificationUseCase.shipped`/`.delivered` — the shipment- and delivery-confirmation fan-out), the four return lifecycle events `retail.return.requested` / `.authorized` / `.received` / `.inspected` (via `ReturnEventsConsumer` → `SendReturnNotificationUseCase.requested`/`.authorized`/`.received`/`.inspected` — the buyer-facing return-status fan-out, recipient derived from the RMA's `customerId`), and `retail.refund.issued` (via `RefundEventsConsumer` → `SendRefundNotificationUseCase.issued` — the refund-confirmation fan-out), all arriving on `notification_events`. The retail publishers emit each of these through the `NOTIFICATION_MICROSERVICE` client so they land on the consumer's own queue (the producer-targets-consumer-queue pattern, ADR-008/020), exactly as `retail.order.placed` does. (`retail.return.rejected` / `.closed` and `retail.refund.failed` stay reserved on `retail_queue` with no consumer — those are operational outcomes, not buyer notifications.) `LogNotifierAdapter` writes the structured notification to Pino at `info` level — useful as a development sink and as the canonical implementation. Switching to email or webhook delivery is a single `useExisting`/`useClass` rebind in `notifications.module.ts` once those adapters are implemented. The notification microservice is RMQ-only (no HTTP surface); its health check rides the same transport as the event subscribers. See [ADR-011](docs/adr/011-notifier-port-and-adapters.md).

The inventory microservice exposes a single `stock` bounded context laid out the same way:

```
apps/inventory-microservice/src/
├── app/app.module.ts                          # imports StockModule + LoggerModule + CacheModule + DatabaseModule
├── main.ts                                    # first import: @retail-inventory-system/observability/tracer
└── modules/stock/
    ├── domain/
    │   ├── stock-level.model.ts               # per-location running totals (changeOnHand; available getter; version)
    │   ├── stock-location.model.ts            # StockLocation aggregate (string PK; StockLocationTypeEnum; active flag)
    │   ├── reservation.model.ts               # Reservation hold (TTL; status machine; reactivate; UUID PK) — ADR-030
    │   ├── stock-movement.model.ts            # StockMovement append-only ledger record (frozen; sign-per-type; no mutators) — ADR-030
    │   ├── inventory.exception.ts             # InventoryDomainException + InventoryErrorCodeEnum
    │   └── events/                            # StockReceived/Adjusted/Low/LevelInitialized + StockReserved/Released/Allocated events
    ├── application/
    │   ├── ports/
    │   │   ├── stock.repository.port.ts       # IStockRepositoryPort + STOCK_REPOSITORY symbol
    │   │   ├── reservation.repository.port.ts # IReservationRepositoryPort + RESERVATION_REPOSITORY symbol (scope-aware) — ADR-030
    │   │   ├── stock-movement.repository.port.ts # IStockMovementRepositoryPort + STOCK_MOVEMENT_REPOSITORY (append + listByVariant only) — ADR-030
    │   │   ├── stock-cache.port.ts            # IStockCachePort + STOCK_CACHE symbol (getOrLoad / withInvalidation)
    │   │   ├── stock-events.publisher.port.ts # IStockEventsPublisherPort + STOCK_EVENTS_PUBLISHER symbol
    │   │   └── transaction.port.ts            # ITransactionPort + TRANSACTION_PORT symbol (opaque ITransactionScope)
    │   └── use-cases/
    │       ├── query-availability.use-case.ts # cache-aside per-variant availability read
    │       ├── list-locations.use-case.ts     # stock-location list (uncached)
    │       ├── list-stock-movements.use-case.ts # paginated, filterable audit-ledger read (uncached) — ADR-030
    │       ├── receive-stock.use-case.ts      # quantityOnHand += n + receipt movement (post-commit invalidation)
    │       ├── adjust-stock.use-case.ts       # signed delta + reasonCode + adjustment movement (rejects below-zero → 409)
    │       ├── transfer-stock.use-case.ts     # two-location on-hand move + two paired adjustment movements — ADR-030
    │       ├── reserve-stock.use-case.ts      # no-oversell hold; idempotent-by-absolute-qty on the triple — ADR-030
    │       ├── release-reservation.use-case.ts # return held units + append a release movement — ADR-030
    │       ├── allocate-stock.use-case.ts     # commit a cart's holds into an order at place-time (all-lines-atomic) — ADR-030
    │       ├── cancel-allocation.use-case.ts  # reverse an order's allocation (no holds touched) — ADR-030
    │       └── auto-init-stock-level.use-case.ts # zero a StockLevel on catalog.variant.created
    ├── infrastructure/
    │   ├── persistence/                       # StockLevel/StockLocation/Reservation/StockMovement entities + mappers + StockTypeormRepository + ReservationTypeormRepository + StockMovementTypeormRepository (insert-only) + TypeormTransactionAdapter
    │   ├── cache/stock.cache.ts               # STOCK_CACHE adapter; preserves ADR-002 cache-aside contract
    │   ├── consumers/catalog-events.consumer.ts # @EventPattern catalog.variant.created → AutoInitStockLevelUseCase
    │   ├── messaging/stock-rabbitmq.publisher.ts # STOCK_EVENTS_PUBLISHER adapter (inventory_queue + notification_events)
    │   └── stock.module.ts                    # binds the port symbols → adapters; APP_FILTER → InventoryRpcExceptionFilter
    └── presentation/
        ├── stock.controller.ts                # 12 @MessagePattern: stock-level.get/receive/adjust/transfer, location.list, stock-movement.list, reservation.reserve/release/allocate, allocation.cancel, stock.commit-sale, stock.restock-from-return
        └── inventory-rpc-exception.filter.ts  # maps InventoryErrorCodeEnum → HTTP status
```

The `stock` context keys everything on the catalog **`variantId`** (an opaque cross-service FK to `product_variant`), not a local product id. `StockLevel` persists running totals per `(variantId, stockLocationId)` and exposes `changeOnHand(delta)` (Receive/Adjust) plus the reserve-side `reserve(n)` / `releaseReserved(n)`, the allocate-side `allocateFromReserved(n)` / `allocateDirect(n)` / `releaseAllocated(n)`, and the ship-side `commitSale(n)` (decrements on-hand **and** allocated in one `version` bump, ADR-031) mutators (with `available = onHand − allocated − reserved` a pure getter); `StockLocation` is a first-class aggregate with a caller-assigned string PK (`default-warehouse` is auto-provisioned by the migration). The **`Reservation` hold** ([ADR-030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)) is a TTL-bounded, cart-scoped hold (plain class like `StockLevel`, app-generated `CHAR(36)` UUID PK) whose `quantity` moves `StockLevel.quantityReserved`, with a status machine `active → committed` / `active → released` / `active → expired` and a `reactivate` row-reuse path that keeps the all-statuses UNIQUE `(cart_id, variant_id, stock_location_id)` triple workable when a removed line is re-added. The **`StockMovement` append-only audit ledger** (ADR-030 §2) is an immutable, frozen domain record (`StockMovement.record`/`reconstitute`, no mutators) whose six `type`s carry a **fixed sign** (`+` receipt/return, `−` sale/allocation/release, `±` non-zero adjustment); the `stock_movement` table (BIGINT PK, signed `quantity`, polymorphic FK-less `reference_type`/`reference_id`, a descending `(variant_id, occurred_at)` index, inert `updated_at`/`deleted_at`); and the `STOCK_MOVEMENT_REPOSITORY` port whose **`append` + `listByVariant`-only** surface makes UPDATE/DELETE inexpressible. It is an **audit trail, not the balance authority** — the running totals stay the source of truth, and row sums never reconstruct on-hand. **Reserve Stock, Release Reservation, Allocate Stock, and Cancel Allocation are all live** (`inventory.reservation.reserve` / `.release` / `.allocate` + `inventory.allocation.cancel`): Reserve enforces the no-oversell guard (a `409 INVENTORY_OUT_OF_STOCK` carrying `details.available`) and is idempotent-by-absolute-quantity on the triple, Release returns the held units and appends one negative `release` movement per hold; **Allocate** converts a cart's holds into an order's allocation at place-time (refresh-then-commit for a wall-clock-stale-but-held hold; a direct-allocation fallback against `available` when no hold exists — the request carries the order lines so the fallback needs no retail read), all-lines-atomic, one `allocation` movement per line; **Cancel Allocation** reverses an order's allocation with a `release` movement per line (no reservation rows touched — its callers, the order-cancel flow and the place-failure compensation, arrive later). All four run inside the shared bounded optimistic write protocol (version-checked persist + 5-attempt retry) and emit reserved-surface events (`inventory.stock.reserved` / `.allocated` / `.released` + the per-insert `inventory.stock-movement.recorded`). The cache key bumped `v2 → v3` to record the new `quantityReserved` semantics. **Receive and Adjust write the ledger too** — each appends a `receipt` / signed `adjustment` movement inside its counter transaction. **Transfer Stock is now live too** (`inventory.stock-level.transfer`, fronted at `POST /api/inventory/variants/:variantId/stock/transfer` behind `inventory:transfer`): it moves on-hand between two locations of one variant atomically — two version-checked `StockLevel` writes + two paired `adjustment` movements (sharing a `transfer` reference id) in one transaction — so **every counter-changing inventory operation now leaves a `StockMovement`**. **Commit Sale is now live too** ([ADR-031](docs/adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)): `inventory.stock.commit-sale` (→ `CommitSaleUseCase`) physically ships an order's allocated stock at fulfillment time — per line it decrements **both** on-hand and allocated via `StockLevel.commitSale` (`available` unchanged) and appends one strictly-negative `sale` movement referencing the fulfillment; it is **all-lines-atomic** and **idempotent on `fulfillmentId`** (a `sale` row already referencing the fulfillment short-circuits the replay), and it is the `sale` ledger type's first producer. **Restock from Return is now live too** ([ADR-032](docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)): `inventory.stock.restock-from-return` (→ `RestockFromReturnUseCase`) returns a return request's `restock`-disposition stock to sellable inventory at inspection time — per line it raises on-hand via `StockLevel.changeOnHand(+quantity)` (reserved/allocated untouched, so `available` rises by the same amount — no new mutator) and appends one strictly-positive `return` movement (`referenceType: 'return-request'`, `referenceId: returnRequestId`); it is **all-lines-atomic** and **idempotent on `returnRequestId`** (a `return` row already referencing the request short-circuits the replay), lazy-inits a missing level at the receiving location, emits `inventory.stock.returned` per line, and **skips the low-stock re-check** (a restock only raises on-hand). It is the long-dormant `return` ledger type's first producer (the mirror of Commit Sale's `sale`), reached retail → inventory over RabbitMQ after the local inspect commit (the retail Inspect & Disposition caller follows). The **retail microservice drives the reservation surface** — the cart write path reserves on add/change + releases on remove, and Place Order allocates inside the conversion transaction (with a best-effort cancel-allocation compensation). The **audit read is now live too** (`inventory.stock-movement.list` → `ListStockMovementsUseCase`, fronted at `GET /api/inventory/variants/:variantId/movements` behind `inventory:read`): a paginated, filterable, newest-first, **uncached** read of one variant's ledger; and a **manual reservation release** (`POST /api/inventory/reservations/:reservationId/release` behind `inventory:adjust`) rides the existing release RPC with the `reservationId` selector + a `manual` reason + the staff `actorId` — the only operator-reachable hold-freeing tool until a TTL sweeper exists. **Still later inventory work**: the TTL sweeper for expired holds (`Reservation.expire()` still has no caller).

`ClientProxy` lives only in `infrastructure/messaging/stock-rabbitmq.publisher.ts` (which injects both the inventory and notification clients), and the cross-service consumer subscribes via `@EventPattern` under `infrastructure/consumers/`. The `STOCK_EVENTS_PUBLISHER` symbol carries the inventory events (`inventory.stock.{received,adjusted,low,reserved,allocated,released,committed}` + `inventory.stock-level.initialized` + the per-ledger-insert `inventory.stock-movement.recorded`); all but `inventory.stock.low` (→ notification) are reserved surfaces on `inventory_queue` with no consumer yet. See [ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md) (which supersedes [ADR-012](docs/adr/012-stock-aggregate-and-port-adapter.md)) for the `StockLevel` / `StockLocation` aggregate boundaries.

The retail microservice hosts the **mutable side of the rebuilt checkout**: the `cart` bounded-context module. Its first-generation `orders` model — a single `Order` aggregate that expanded each line into one `order_product` row per unit, a two-value status, and a cross-service `inventory.order.confirm` reserve call — was torn down in the [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md) checkout rebuild. The `Cart` aggregate root (a caller-assigned `CHAR(36)` UUID id, generated in-app) owns its `CartLine` children; the status machine is `active → converted` (placement) / `active → abandoned` (purge), both terminal. Each mutator (`addLine` increments an existing line rather than duplicating it; `changeLineQuantity` rejects `0`; `removeLine`; `markConverted`; `markAbandoned`) advances a `version` optimistic-concurrency token — shipped now though its guard is a later capability — and records a framework-free domain event. A `CartLine` snapshots its unit price (in minor units) and currency at add-time, so a sibling line's change never re-prices it; `variantId` is the opaque catalog backbone key. The `cart` / `cart_line` tables FK onto the gateway `customer` and the catalog `product_variant` in the one shared database.

The cart's **six operations** run end to end: `CreateCart` / `GetCart` / `AddToCart` / `ChangeCartLineQuantity` / `RemoveFromCart` / `ClaimCart`, served by the retail `cart.controller.ts` (`@MessagePattern` handlers on `retail_queue`) and fronted by the gateway `modules/cart/` over HTTP at `/api/cart`. **Add-to-Cart snapshots the applicable price**: it calls the catalog `catalog.price.select` RPC (through `ICartCatalogGatewayPort`) in the cart's currency and rejects an unknown/unpriced variant with a `409`, so a line always carries a real price. **The cart write path now holds real stock** ([ADR-030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)): Add-to-Cart and Change-Quantity reserve the line's *absolute* target quantity against the inventory reservation surface (`inventory.reservation.reserve`, through `ICartInventoryGatewayPort`) **before** the cart is saved — an out-of-stock target is a `409 { code: 'INVENTORY_OUT_OF_STOCK', details: { available } }` end-to-end and the cart is never mutated; Remove-from-Cart releases the line's hold (`inventory.reservation.release`) **after** save, best-effort; Claim makes no inventory call (holds key on the cart id, which a claim re-points the owner of but never changes). Authorization is **bearer plus an owner-check, not a permission code** ([ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md) / ADR-028): the gateway folds the authenticated `@CurrentUser().id` into every command and the retail use case enforces `cart.customerId === customerId`, so a customer can only touch its own cart — a non-owner gets `403`, an unauthenticated caller `401`. Each mutation emits its reserved-surface `retail.cart.*` event onto `retail_queue` (best-effort, no consumer bound yet). **Guest carts** (Q1/Q7): `POST /auth/customer/guest-session` mints a real `status='guest'` Customer with a null password and a customer-tier token — the guest-tier token replaces a session cookie, so a guest builds a cart through the same bearer-protected routes; `POST /api/cart/:cartId/claim` then promotes a guest cart to a registered customer, re-pointing it only if the supplied `fromCustomerId` (the guest id, the ownership proof) matches the cart's current owner.

It also hosts the **immutable side**: the `orders` module's `Order` aggregate (a DB-assigned `BIGINT` id) owning its `OrderLine` children, plus the polymorphic `Address` aggregate (a caller-assigned `CHAR(36)` UUID) in the same module. An `Order` carries **three orthogonal status axes** — `status`, `paymentStatus`, `fulfillmentStatus` — that evolve independently (a `captured` payment can coexist with `unfulfilled` fulfillment), rather than one combined enum. `Order.place(...)` snapshots the cart's lines into `OrderLine`s (each carrying a `sku`/`nameSnapshot`/`unitPriceMinor` snapshot in minor units — every snapshot field `readonly`; the only mutable field is the line's fulfillment `status`, which the ship operation flips forward `allocated → partially-shipped → shipped` via `markFulfillment`) and derives the five money totals (`grandTotal = subtotal = Σ line totals`; tax/discount/shipping are `0` this capability); payment-axis mutators walk `none → authorized → captured`, and lifecycle mutators `cancel()` (Cancel Order — `pending`/`confirmed → cancelled`) and `markDelivered()` (Mark Delivered — advancing both the lifecycle and fulfillment axes to `delivered`) close the order out. `order.order_number` is a human-facing `ORD-<year>-<8-digit>` label finalized from the generated id (UNIQUE-backed); `order.source_cart_id` links the converted cart for repeat-place idempotency; `order.customer_id` is nullable (a deleted customer leaves a tombstone). An `Address` is **polymorphic** over `ownerType ∈ {customer, order}`; an order's billing/shipping addresses are immutable `ownerType=order` **snapshot copies**, never references into a future customer address book. A `Payment` aggregate is a **sibling in the same module** (it lives there because its operations touch `Order`): `Payment.authorized(...)` opens a row `AUTHORIZED` from a successful gateway authorize, its `capture(at)` mutation walks `AUTHORIZED → CAPTURED`, its `void()` mutation walks `AUTHORIZED → VOIDED` (the Cancel-Order path for an uncaptured payment), and its `refund(amount)` mutation accumulates `refunded_amount_minor` and walks `CAPTURED → REFUNDED` on a **full** refund (clearing the refund flag; a partial leaves it `captured`), plus an idempotent `flagForRefund()` that flags an already-captured payment for refund when its order is cancelled. Payment authorize/capture/**refund** runs behind a `PAYMENT_GATEWAY` port whose default binding is a `FakePaymentGatewayAdapter` — an in-process stand-in that **always approves** with deterministic `fake_<uuid>` / `fake_refund_<uuid>` tokens (a real processor is an excluded capability; the port keeps the place/capture/refund use cases gateway-agnostic, the `NotifierPort` pattern of [ADR-011](docs/adr/011-notifier-port-and-adapters.md)).

**Place Order is live.** `POST /api/cart/:cartId/place` converts an `active` cart into an immutable `Order` one-shot: `PlaceOrderUseCase` snapshots each line from the catalog at write-time (`sku`/`nameSnapshot` via `catalog.variant.get`, `unitPriceMinor` via `catalog.price.select` — a line with no applicable price is rejected `409`), snapshots the billing + shipping addresses from the request body as immutable `ownerType=order` copies, marks the cart `converted`, **and allocates the cart's stock holds into the order** ([ADR-030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)) — inside the same transaction, *after* the conversion compare-and-swap (`inventory.reservation.allocate`, through `IOrderInventoryGatewayPort`; reserved → allocated, or a direct-allocation fallback). The order, its lines, both addresses, the cart conversion, **and the allocation** commit in one transaction (an `orders` `TRANSACTION_PORT`, mirroring the inventory `modules/stock` adapter); an unallocatable line rolls the whole place back (`409 INVENTORY_OUT_OF_STOCK` — no order row, the cart stays `active`), and a rare post-allocate commit failure fires a best-effort `inventory.allocation.cancel` (`reason 'place-rollback'`) compensation. Payment is then authorized inline through the `PAYMENT_GATEWAY` (`AuthorizePaymentUseCase` — authorize-on-place; allocate precedes payment, so money is never authorized for unallocatable stock); the out-of-process gateway authorize and the `Payment` persist run in a short follow-up transaction. The route is bearer-protected with the same retail-side owner-check as the cart routes, and the `Idempotency-Key` header is **accepted + logged but not deduped** — repeat-place safety comes from cart state (a placed cart is `converted`; re-placing returns the order it converted into via `source_cart_id`). On success it returns the `OrderView` (`status=pending`, `paymentStatus=authorized`, `fulfillmentStatus=unfulfilled`, the line snapshots, and the authorized `payment`) and emits `retail.order.placed` (→ `notification_events`) + `retail.payment.authorized` (→ `retail_queue`) best-effort post-commit.

**Capture, Get Order, and List My Orders are live** behind the gateway `modules/orders/` (over HTTP at `/api/orders`). **Capture** (`POST /api/orders/:orderId/payments/capture`) is the explicit second half of the authorize-then-capture policy ([Q5](docs/implementation/05-cart-order-payment-walking-skeleton/07-authorize-on-place-capture-explicit-q5.md)): `CapturePaymentUseCase` calls `PAYMENT_GATEWAY.capture` out of transaction, then advances the `Payment` (`authorized → captured`) and the order's payment axis (`Order.markPaymentCaptured()`) in a short follow-up transaction, and emits `retail.payment.captured`. Re-capturing an already-captured payment returns the current state (idempotent by payment state). **Get Order** (`GET /api/orders/:orderId`) and **List My Orders** (`GET /api/orders`, own-only, paginated, newest-first) are the read paths. **Authorization on all three is bearer + owner-check with a staff override** ([ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md) / [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md)): a customer reaches only its own order, while a staff `order:read` / `order:capture` permission is an *override* that reaches any order — a permission code is never a gate on the owning customer (who carries no permissions). A non-owner non-staff caller gets `403`; an unauthenticated caller `401`.

The **`Fulfillment` aggregate** and its **Create / List / Ship / Deliver + Cancel-Order / Cancel-Line operations** are now live ([ADR-031](docs/adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)), and the inventory side of the ship flow — the cross-service **Commit Sale** RPC (see the inventory section) — is live too; **the gateway HTTP front is now live as well** (six routes under `/api/orders`, described below). A `Fulfillment` (a DB-assigned `BIGINT` id, owning its `FulfillmentLine` children) is a fourth sibling aggregate in the `orders/` module: the **per-shipment, per-location** record that drives an order toward `delivered`. It ships from an opaque inventory `stockLocationId` (retail never imports inventory), and its lines say which `OrderLine` quantities are in this box — so **partial and split shipments are simply multiple `Fulfillment`s per order**. `Fulfillment.status` (`pending → shipped → delivered`, or `cancelled`) is a **fourth status axis** beside the order's three, evolving per shipment; the order's own `fulfillment_status` is the roll-up across its fulfillments. The aggregate enforces its own shape (≥1 line, positive line quantities, legal transitions, and tracking-required-on-ship) while the cross-fulfillment sum (a line's shipped quantity across all shipments ≤ ordered) is enforced by the **Create use case**, which loads the order and its sibling fulfillments. It is **append-only** — cancellation is a `status` flip, never a delete (a `shipped`/`delivered` fulfillment is never cancellable, which is what protects Cancel Order). The `fulfillment` / `fulfillment_line` tables, the `FulfillmentTypeormRepository` (`FULFILLMENT_REPOSITORY`), the `FulfillmentStatusEnum` + `FulfillmentView`, and the nine `OrderErrorCodeEnum` fulfillment/cancel codes (all mapped in the orders RPC exception filter) are live.

**Create / List Fulfillment** are RPC operations served by the orders controller (a `Fulfillment` is a sibling aggregate of `Order`), fronted over HTTP at `/api/orders` (below). `retail.fulfillment.create` plans a `pending` shipment (one or more `OrderLine` quantities) and `retail.fulfillment.list` reads an order's shipments newest-first. Create is authorized **owner-or-staff `order:fulfill`** and List **owner-or-staff `order:read`** (the same owner-or-staff split as the order read/capture keys). Create requires the order to be in a fulfillable state (lifecycle `pending`/`confirmed` and payment `authorized`/`captured`, else `409 ORDER_NOT_FULFILLABLE`), defaults the source location to `default-warehouse`, and enforces the cross-fulfillment sum against the **already-fulfilled remainder** — the per-`OrderLine` total across the order's non-`cancelled` fulfillments — rejecting an unknown line `404` or an over-ship `409`. It leaves the order/line statuses untouched (a line flips to `partially-shipped` only once units are in flight, the ship operation's job) and emits a best-effort `retail.fulfillment.created` event.

**Ship Fulfillment** (`retail.fulfillment.ship` → `ShipFulfillmentUseCase`, owner-or-staff `order:fulfill`, fronted at `POST /api/orders/:orderId/fulfillments/:fulfillmentId/ship`) is the operation that physically moves stock and takes the money — it advances three status axes and crosses the service boundary. Preconditions: the fulfillment exists, belongs to the order, and is `pending` (a non-`pending` re-ship is `409`; a `tracking_number` is required — `400` otherwise). **Ship-triggered automatic capture (Q5)**: if the order's payment is still `authorized`, Ship captures it **inline through `PAYMENT_GATEWAY.capture` _before_ the local commit** — a decline **blocks the ship** (`409 ORDER_PAYMENT_NOT_CAPTURED`, nothing written, no `pending-with-payment-failure` state); an already-`captured` payment skips the gateway. In one local transaction it advances the `Fulfillment → shipped` (stamping `shippedAt` + tracking), records the capture (`Payment → captured`, `Order.markPaymentCaptured()`) when one happened, flips each shipped `OrderLine.status` (`shipped` vs `partially-shipped`, derived from the order's fulfillments' shipped quantities), and advances the order's roll-up `fulfillmentStatus` (`shipped` iff every line is fully shipped, else `partially-shipped`, via `Order.advanceFulfillment`). **After** the commit it calls the cross-service `inventory.stock.commit-sale` (through the module-prefixed `ORDER_COMMIT_SALE_GATEWAY` port) to physically decrement stock — retried on transient failure, and on a hard failure logged-for-replay (the local ship is **not** rolled back; Commit Sale's `fulfillmentId` idempotency makes the replay safe). It then emits `retail.fulfillment.shipped` (+ `retail.payment.captured` when it captured) best-effort post-commit, and returns the updated `FulfillmentView`. See [docs/implementation/08-fulfillment-and-ship-flow/03-ship-triggered-capture-q5.md](docs/implementation/08-fulfillment-and-ship-flow/03-ship-triggered-capture-q5.md).

**Mark Delivered, Cancel Order, and Cancel Line** (`retail.fulfillment.deliver` / `retail.order.cancel` / `retail.order.cancel-line`, fronted over HTTP at `/api/orders`, below) close out the lifecycle. **Mark Delivered** (`MarkDeliveredUseCase`, owner-or-staff `order:fulfill`) delivers a `shipped` fulfillment and — once **every** non-`cancelled` fulfillment of the order is delivered — rolls the order up to `delivered` on both the lifecycle and fulfillment axes in the same transaction (the carrier-webhook-less happy-path terminal, driven by an operator). **Cancel Order** (`CancelOrderUseCase`, owner-or-staff `order:cancel` — a customer may cancel its own pending order) refuses an order with any `shipped`/`delivered` fulfillment (`409 ORDER_NOT_CANCELLABLE`; the lifecycle axis stays `pending` after a ship, so this fulfillment-presence check, not the lifecycle guard, is the real shipped-stock guard), then in one transaction cancels the order, cancels any `pending` fulfillments, and settles the payment — an `authorized` payment is **voided**, a `captured` one is **flagged for refund** (`flagged_for_refund = true`; the `OrderCancelledConsumer` then auto-issues the actual refund, below) — and **after** the commit releases the order's stock allocation through the existing `inventory.allocation.cancel` (best-effort, retried-then-logged, never rolled back), emitting `retail.order.cancelled` (carrying `paymentFlaggedForRefund`, a key [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md) had retired and this producer re-introduces). **Cancel Line** (`CancelLineUseCase`, **staff** `order:cancel`) cancels the **unshipped** quantity of a single `OrderLine` (`ordered − the per-line total across non-cancelled fulfillments`; an omitted quantity cancels all of it, an over-remainder request is `409`), releases just that quantity's allocation proportionally, and makes **no money-total change and emits no event** (a credit/refund is the later refund capability's job). See [docs/implementation/08-fulfillment-and-ship-flow/05-cancel-order-and-line.md](docs/implementation/08-fulfillment-and-ship-flow/05-cancel-order-and-line.md).

**The gateway HTTP front for the whole fulfillment + cancel surface is live** — six new routes under `/api/orders`, fronted by the gateway `modules/orders/` over the retail RPCs ([ADR-009](docs/adr/009-port-adapter-at-the-gateway.md)): `POST /api/orders/:orderId/fulfillments` (Create → `FulfillmentView` 201), `GET /api/orders/:orderId/fulfillments` (List → `FulfillmentView[]`), `POST …/fulfillments/:fulfillmentId/ship` (Ship → `FulfillmentView` 200, an `Idempotency-Key` header accepted-not-deduped), `POST …/fulfillments/:fulfillmentId/deliver` (Mark Delivered → `FulfillmentView` 200), `POST /api/orders/:orderId/cancel` (Cancel Order → `OrderView` 200), and `POST /api/orders/:orderId/lines/:lineId/cancel` (Cancel Line → `OrderView` 200). Two authorization shapes coexist ([ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md) / [ADR-028](docs/adr/028-cart-order-payment-and-address-chain.md) §7): **List fulfillments** (owner-or-staff `order:read`) and **Cancel Order** (owner-or-staff `order:cancel` — a customer may cancel its own pending order) carry **no `@RequiresPermission`** so the owning customer is never blocked, with the staff override computed at the gateway from `@CurrentUser().permissions` and the owner-check enforced retail-side; **Create / Ship / Deliver** (`order:fulfill`) and **Cancel Line** (`order:cancel`) are staff-only operations and are gated with `@RequiresPermission` directly. Typed upstream codes (`FULFILLMENT_*` / `ORDER_*`) surface as 400/404/409 through `throwRpcError` (the typed `code` + any `details` forwarded). `OrdersRabbitmqAdapter` stays the module's sole `ClientProxy` holder. The two Kulala files [`http/fulfillment.http`](http/fulfillment.http) (the create → ship → deliver happy flow) and [`http/order-cancel.http`](http/order-cancel.http) (owner-cancel, shipped-order `409`, cancel-line) document the surface end-to-end.

The retail service also hosts a new **`returns` bounded context** ([ADR-032](docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)) — and the **full RMA lifecycle is now live**, over RabbitMQ **and fronted over HTTP** by the gateway `modules/returns/` (eight routes — `POST /api/orders/:orderId/returns` + `GET /api/orders/:orderId/returns` + the six `/api/returns/:rmaId/*` lifecycle routes; see [docs/implementation/09-returns-and-refunds/06-returns-and-refunds-api-and-http-files.md](docs/implementation/09-returns-and-refunds/06-returns-and-refunds-api-and-http-files.md)). A `ReturnRequest` (a DB-assigned `BIGINT` id, owning its `ReturnLine` children) is the RMA (Return Merchandise Authorization) record that drives a delivered or shipped order's return through a **six-state lifecycle** — `requested → authorized → received → inspected → closed`, with `requested → rejected` as the early-rejection branch (`rejected` and `closed` terminal). It is a **new module** rather than a sibling in `orders/`, because the lifecycle is a substantial state machine with warehouse-facing operations (Receive, Inspect) distinct from order placement; it gets its own `ReturnDomainException`. Each `ReturnLine` says which `OrderLine` quantity is coming back; its `condition` / `disposition` / `lineRefundAmountMinor` are recorded later at inspection (null until then). `rmaNumber` is a human-facing `RMA-<year>-<8-digit>` finalized from the generated id (the `order_number` idiom), and `customer_id` is the gateway customer's `CHAR(36)` UUID (the buyer, copied from the order). The aggregate is append-only — rejection and closure are status transitions, never deletes.

The eight RPCs (served by the returns controller off `retail_queue`) are: **`retail.return.open`** → `OpenReturnRequestUseCase` (owner-or-staff `order:return-authorize`) reads the order through a raw-SQL `RETURN_ORDER_READER` (the `ORDER_CART_READER` cross-module precedent — returns never imports `orders/`), enforces the **return-eligibility window** (a `delivered` order is always returnable; a `shipped` one only within `RETURN_WINDOW_DAYS`, default `30` — `RETURN_WINDOW_EXPIRED` past it, `RETURN_ORDER_NOT_RETURNABLE` if neither) and the **returnable-quantity** invariant (`requested ≤ ordered − cancelled − already-returned`, the already-returned sum excluding rejected RMAs — `RETURN_QUANTITY_EXCEEDS_RETURNABLE` / `RETURN_ORDER_LINE_NOT_FOUND`), then opens the RMA, finalizes the `RMA-<year>-…` number, and emits `retail.return.requested`; **`retail.return.authorize` / `.reject` / `.receive` / `.close`** walk the status machine (staff `order:return-authorize` for authorize/reject/close, warehouse `inventory:receive-return` for receive — each `RETURN_NOT_FOUND` on a missing id, `RETURN_INVALID_STATUS_TRANSITION` on an illegal start; Reject appends its reason to `notes`); **`retail.return.inspect`** → `InspectAndDispositionUseCase` (warehouse `inventory:receive-return`) records each line's condition + disposition + refund amount and walks `received → inspected` in one transaction (the inspection must cover **every** RMA line — `RETURN_LINE_NOT_FOUND` for an unknown line, `RETURN_INSPECTION_INVALID` for an incomplete set), then — **after** the local commit — for every `restock`-disposition line resolves the variant (via `RETURN_ORDER_READER`) + a `default-warehouse` location and calls the cross-service `inventory.stock.restock-from-return` RPC through `INVENTORY_RESTOCK_GATEWAY` (bounded-retry-then-log; the inspection is never rolled back, the RPC idempotent on `returnRequestId`); a no-`restock` return makes no inventory call, and the per-line refund amounts are recorded for a later Issue Refund (Inspect issues **no** refund); **`retail.return.get` / `.list`** are owner-or-staff `order:read` reads. The lifecycle events split by the producer-targets-consumer-queue pattern: `requested` / `authorized` / `received` / `inspected` land on `notification_events` (the buyer-facing ones, consumed later), `rejected` / `closed` on `retail_queue` (reserved). This ships the model, the `return_request` / `return_line` tables, the repository (`RETURN_REQUEST_REPOSITORY`) + order reader (`RETURN_ORDER_READER`) + events publisher (`RETURN_EVENTS_PUBLISHER`) + restock gateway (`INVENTORY_RESTOCK_GATEWAY`) + transaction port, the four wire enums + `ReturnRequestView` / `ReturnLineView` + the eight command + six event contracts, and the `ReturnsModule` with its controller + total `ReturnRpcExceptionFilter`. The gateway HTTP endpoints, the `Refund` operations (Issue Refund), the auto-refund-from-cancel consumer, and the notification return/refund fan-out (`ReturnEventsConsumer` / `RefundEventsConsumer`, below) are all live too.

The **`Refund`** aggregate is a **fifth sibling aggregate inside `orders/`** (not `returns/`). A `Refund` (DB-assigned `BIGINT` id) is the record of one gateway refund interaction against a captured `Payment`; it lives in `orders/` because its operations **mutate `Payment`** (walking its status and incrementing `refunded_amount_minor`), reusing `OrderDomainException`. It is a **distinct entity** from `ReturnRequest`, because a refund must exist with no return behind it — a chargeback, a goodwill credit, a partial price adjustment, or a refund Cancel Order issues on an unshipped order — so a return that closes with money owed *triggers* a refund rather than *being* one. Its `RefundStatusEnum` walks `pending → issued | failed` (terminal), with `gatewayReference` / `issuedAt` stamped on issue; `amountMinor` is **strictly positive** (unlike `Payment.amountMinor`, which allows 0). The over-refund ceiling (`amount ≤ amount_minor − refunded_amount_minor`) is **not** in the model — it cannot see `Payment`; the Issue Refund use case enforces it.

**Issue Refund and List Refunds are now live** ([ADR-032](docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md), served by the orders controller over RabbitMQ **and fronted over HTTP** by the gateway `modules/orders/` refund extension — `POST /api/orders/:orderId/refunds` (staff `order:refund`) + `GET /api/orders/:orderId/refunds` (owner-or-staff `order:read`)). **Issue Refund** (`retail.refund.issue` → `IssueRefundUseCase`, **staff** `order:refund`) loads the order + payment, enforces the preconditions (the payment must be `captured` — `REFUND_PAYMENT_NOT_CAPTURED` — and the amount must fit the **refundable ceiling** — `REFUND_EXCEEDS_REFUNDABLE`), opens a `pending` `Refund`, calls `PAYMENT_GATEWAY.refund()` **outside** the transaction (the `FakePaymentGatewayAdapter` always succeeds with a fresh `fake_refund_<uuid>` reference), then runs `Payment.refund(amount)` (accumulating `refunded_amount_minor`, flipping the payment to `refunded` **and clearing the refund flag** only on a **full** refund — a partial leaves it `captured`) + `Refund.markIssued(...)` in **one short transaction** (the Capture precedent), **always audits** the money movement (the cross-cutting always-audit rule, written retail-side via the `AUDIT_LOG_PUBLISHER` port → a default log-only `NoOpAuditLogPublisher`, so it covers the auto-refund path too), and emits `retail.refund.issued` (→ `notification_events`); a gateway decline (modeled, unreachable with the fake) records a `failed` refund and emits `retail.refund.failed`. It is **naturally idempotent** — the `Idempotency-Key` header is accepted-not-deduped, but an already-`issued` refund for the same `(payment, amount, reason)` short-circuits with no second gateway call, and the `refunded_amount_minor` ceiling stops any replay over-refunding. **List Refunds** (`retail.refund.list` → `ListRefundsForOrderUseCase`, owner-or-staff `order:read`, `REFUND_ACCESS_FORBIDDEN` for a non-owner-non-staff caller) returns the order's `RefundView[]` newest-first.

**The auto-refund-from-cancel consumer is now live too** ([ADR-032](docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)): `OrderCancelledConsumer` (an `@EventPattern retail.order.cancelled` subscriber in the orders module's `infrastructure/consumers/`) listens to retail's **own** cancel event on `retail_queue` and, when `paymentFlaggedForRefund=true`, resolves the captured `Payment` and **inline**-calls `IssueRefundUseCase` for the still-refundable remainder (`amountMinor − refundedAmountMinor`, only if `> 0`) with `reason: 'order-cancelled'` and a system (`null`) actor — so a captured order cancelled before it ships is both flagged **and** actually refunded. It reuses the one audited use case (no cross-service hop, no new deployable), and its idempotency falls out of the refundable-amount guard (a redelivery after a full refund computes `0` and no-ops — no job table; RabbitMQ is at-least-once); a downstream failure is warn-logged and swallowed, leaving the payment `flagged_for_refund` as the durable manual-retry anchor. The gateway HTTP refund endpoints and the notification refund fan-out (`RefundEventsConsumer` → `SendRefundNotificationUseCase`, in the notification service) are now live too. See [docs/implementation/09-returns-and-refunds/04-auto-refund-from-cancel-order.md](docs/implementation/09-returns-and-refunds/04-auto-refund-from-cancel-order.md) and [05-fake-gateway-refund-method.md](docs/implementation/09-returns-and-refunds/05-fake-gateway-refund-method.md).

The whole returns + refunds capability is locked end-to-end by four gateway e2e suites that drive the HTTP routes and assert through public state (order/refund reads, the public stock read, the uncached movements ledger): [`test/return-restock-refund.e2e-spec.ts`](test/return-restock-refund.e2e-spec.ts) (the Stage-2 place → ship → deliver → open → authorize → receive → inspect-`restock` → close → refund chain — on-hand rises by the restocked quantity, one positive `return` movement appears, a partial refund leaves the payment `captured`), [`test/return-rejected.e2e-spec.ts`](test/return-rejected.e2e-spec.ts) (the open-time `RETURN_ORDER_NOT_RETURNABLE` / `RETURN_QUANTITY_EXCEEDS_RETURNABLE` guards + an explicit reject, all leaving stock untouched), [`test/auto-refund-from-cancel.e2e-spec.ts`](test/auto-refund-from-cancel.e2e-spec.ts) (capture-then-cancel → the consumer auto-issues a full refund, polled to `refunded`), and [`test/manual-refund.e2e-spec.ts`](test/manual-refund.e2e-spec.ts) (a goodwill partial refund, the double-issue idempotency assertion, the over-refund ceiling, and the full-remainder flip to `refunded`).

```
apps/retail-microservice/src/
├── app/app.module.ts                          # ConfigModule + LoggerModule + DatabaseModule.forRoot([...cartEntities, ...orderEntities, ...returnEntities]) + CartModule + OrdersModule + ReturnsModule
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
│   ├── domain/                                # Order + OrderLine + polymorphic Address + Payment + Fulfillment + Refund aggregates, OrderDomainException
│   ├── application/ports/                     # IOrder/Address/Payment/Fulfillment/RefundRepositoryPort + IPaymentGatewayPort (PAYMENT_GATEWAY)
│   └── infrastructure/
│       ├── persistence/                       # order/order_line/address/payment/fulfillment/refund entities, mappers, *TypeormRepository
│       ├── payment-gateway/                   # FakePaymentGatewayAdapter (default PAYMENT_GATEWAY — always approves, fake tokens)
│       └── orders.module.ts                   # DatabaseModule.forFeature + the repository bindings (incl. REFUND_REPOSITORY) + PAYMENT_GATEWAY → FakePaymentGatewayAdapter
├── modules/returns/                           # the RMA bounded context (ADR-032) — the full lifecycle is live (over RMQ + fronted at /api/returns + /api/orders/:id/returns)
│   ├── domain/                                # ReturnRequest + ReturnLine aggregate, ReturnDomainException + ReturnErrorCodeEnum
│   ├── application/
│   │   ├── ports/                             # RETURN_REQUEST_REPOSITORY + RETURN_ORDER_READER + RETURN_EVENTS_PUBLISHER + INVENTORY_RESTOCK_GATEWAY + TRANSACTION_PORT + RETURN_WINDOW_DAYS token
│   │   └── use-cases/                         # Open/Authorize/Reject/Receive/Inspect/Close + Get/List + return-view.factory + return-access + retry-then-log-for-replay helpers
│   ├── infrastructure/
│   │   ├── persistence/                       # return_request/return_line entities, mappers, repo, ReturnOrderReaderTypeormAdapter (raw SQL), TypeormTransactionAdapter
│   │   ├── messaging/                         # ReturnRabbitmqPublisher (two clients: notification_events + retail_queue) + InventoryRestockRabbitmqAdapter (inventory_queue)
│   │   └── returns.module.ts                  # forFeature + reader/publisher/restock-gateway/transaction/window bindings + 8 use cases + APP_FILTER (ReturnRpcExceptionFilter)
│   └── presentation/                          # returns.controller.ts (8 @MessagePatterns) + return-rpc-exception.filter.ts
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

The reservation + stock-movement capability is locked end-to-end by four gateway suites: `test/cart-reserve-release.e2e-spec.ts` (reserve on add/change, release on remove, the out-of-stock `409`), `test/place-order-allocates.e2e-spec.ts` (place converts holds to one `allocation` ledger row per order line), `test/inventory-movements-audit.e2e-spec.ts` (the ledger timeline, filters, paging, permission gates), and the canonical **`test/concurrent-oversell.e2e-spec.ts`** — two carts race for the last unit, exactly one wins, the loser gets `409 INVENTORY_OUT_OF_STOCK` with `available: 0`, and the final stock state is consistent down to the ledger. The concurrency proof is winner-agnostic and must stay green across 5 consecutive runs; the exact run + 5× stability commands and how to read the assertions are in [docs/implementation/07-inventory-reservation-and-stock-movement/11-concurrent-oversell-e2e.md](docs/implementation/07-inventory-reservation-and-stock-movement/11-concurrent-oversell-e2e.md).

The fulfillment + ship + cancel capability is locked by six more gateway suites that drive the HTTP surface (login → place → fulfill → ship → deliver / cancel) and assert through **public state** (order `GET`, the public stock read, the uncached movements ledger — never event spies): `test/fulfillment-happy-path.e2e-spec.ts` (all four status axes advance, one `sale` movement per shipped line, on-hand **and** allocated both decrement), `test/fulfillment-partial-ship.e2e-spec.ts` (two fulfillments → `partially-shipped` then `shipped` roll-up), `test/cancel-order-pre-fulfillment.e2e-spec.ts` (cancel → payment voided + allocation released), `test/cancel-order-blocked-after-ship.e2e-spec.ts` (`409 ORDER_NOT_CANCELLABLE` once shipped), `test/ship-triggers-capture.e2e-spec.ts` (place leaves `authorized`, ship auto-captures), and the **`test/concurrent-ship-cancel.e2e-spec.ts`** ship-vs-cancel race (winner-agnostic, 5×-stable — the `findByIdForUpdate` row-lock guard). All six self-provision disjoint variants so they never contend with the seed or each other.

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

# Categories (a self-hierarchical tree on a materialized path)
POST   /api/catalog/categories                        # bearer + catalog:write  — create a root or child category
PATCH  /api/catalog/categories/:slug/parent           # bearer + catalog:write  — reparent (or demote to root) + rebase its subtree
GET    /api/catalog/categories                        # public  — flat active list (?root for roots only)
GET    /api/catalog/categories/:slug/tree             # public  — nested active subtree from a root
GET    /api/catalog/categories/:slug/products         # public  — paged active products (?includeDescendants, ?page, ?pageSize)
POST   /api/catalog/products/:productId/categories    # bearer + catalog:write  — attach a product to categories (200)
DELETE /api/catalog/products/:productId/categories/:categorySlug  # bearer + catalog:write  — detach a product from one category

# Media (polymorphic assets on a product or a variant)
POST   /api/catalog/media                             # bearer + catalog:write  — attach an asset (appends at max sort_order + 1)
PATCH  /api/catalog/media/reorder                     # bearer + catalog:write  — bulk re-sequence (exact permutation, all-or-nothing)
DELETE /api/catalog/media/:id                         # bearer + catalog:write  — detach (state-guarded active → archived flip)
GET    /api/catalog/products/:productId/media         # public  — a product's active media, sort_order ASC
GET    /api/catalog/variants/:variantId/media         # public  — a variant's active media, sort_order ASC
```

The category writes reuse `catalog:write` — **no new permission code was minted** for category/media authoring ([ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md)). The attach/detach membership routes both fold onto the single `catalog.product.reclassify` RPC (attach sends only the attach list, detach only the detach list) and return the **full** post-op membership view with a `200` (a membership update, not a creation). The two media `GET`s share one `ListMedia` use case, the controller folding the matching owner type; an unknown owner is a `200 []`, not a 404. See [docs/implementation/06-catalog-category-and-media/05-category-and-media-api.md](docs/implementation/06-catalog-category-and-media/05-category-and-media-api.md).

#### Catalog navigation

Categories form a **tree** via a `parentId` plus a **materialized `path`** — each `category` row stores its full root-to-self slug chain (`/electronics/phones`), so a subtree read is one indexed `path LIKE '/electronics%'` and an ancestry test is a pure string-prefix check rather than a recursive walk. **Reparenting rewrites the moved node's subtree in a single transaction**: the domain recomputes the moved node's own `parentId` + `path` (rejecting a cycle — you cannot move a category under itself or a descendant), then the repository rebases every descendant's `path` with one bulk `UPDATE … CONCAT/SUBSTRING … WHERE path LIKE` (the response carries the descendant-rewrite count). The browse endpoints **filter to active** and an archived intermediate hides its whole branch; `…/categories/:slug/products` can **include descendants** by expanding the materialized path prefix into the id scope (`?includeDescendants`). **Media attaches polymorphically** — one `media_asset` table hangs an asset off either a product or a variant via `(owner_type, owner_id)` with no foreign key on the polymorphic owner. The full design is recorded in [ADR-029](docs/adr/029-category-materialized-path-and-polymorphic-media.md), with the per-topic walkthroughs under [docs/implementation/06-catalog-category-and-media/](docs/implementation/06-catalog-category-and-media/).

The publish route enforces an **active-price precondition**: it `409`s (`PRODUCT_PUBLISH_REQUIRES_PRICE`) unless *every* variant has an in-effect price in the configured currency. A second, **softer** precondition rides the same response: when the published product (and none of its variants) has an active media asset, the publish *still proceeds* but the `ProductView` carries a `warnings[]` entry with the code `CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA` — a recommendation to attach at least one image, never a block. The contrast is deliberate: a price-less product breaks checkout (hard 409), a media-less one only looks bare (soft warning). A clean publish omits `warnings` entirely. The currency the price gate resolves against is an environment variable read by the catalog microservice:

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `DEFAULT_CURRENCY` | `USD` | ISO-4217 currency the catalog publish precondition resolves against (Joi-validated `length(3).uppercase()`). A product publishes only when each variant has a price in this currency. |

### Inventory

```
GET  /api/inventory/locations                          # bearer + inventory:read   — list stock locations (?activeOnly)
GET  /api/inventory/variants/:variantId/stock          # public  — per-location availability + totals (?locationIds=a,b)
GET  /api/inventory/variants/:variantId/movements      # bearer + inventory:read   — audit ledger page (?page, ?pageSize, ?type, ?from, ?to)
POST /api/inventory/variants/:variantId/stock/receive  # bearer + inventory:adjust   — raise on-hand { stockLocationId?, quantity }
POST /api/inventory/variants/:variantId/stock/adjust   # bearer + inventory:adjust   — signed delta { stockLocationId?, quantityDelta, reasonCode }
POST /api/inventory/variants/:variantId/stock/transfer # bearer + inventory:transfer — move on-hand between two locations { fromLocationId, toLocationId, quantity }
POST /api/inventory/reservations/:reservationId/release # bearer + inventory:adjust  — manually free one hold (reason 'manual') → { released }
```

The variant-stock read is **cache-aside** (Redis): the `VariantStockView` response (per-location `StockLevelView` rows + cross-location `totalOnHand` / `totalAvailable`) is cached under `ris:inventory:stock:v3:<variantId>:<facet>`. Omitting `?locationIds` aggregates across all stock locations (the comma-separated facet is `__all__`); passing a subset scopes the answer. A variant with no stock rows is a `200` zero-availability answer (`locations: []`), not a 404. The migration provisions a `default-warehouse` location and the seed (`scripts/seeds/stock-level.sql`) gives every seeded catalog variant 100 on hand there, so the public read returns a real figure out of the box.

The three **write** routes are staff-only. **Receive** (`inventory:adjust`) raises `quantityOnHand` by a positive `quantity`; **Adjust** (`inventory:adjust`) applies a signed `quantityDelta` with a mandatory `reasonCode` and rejects a result below zero with a `409`. Both default `stockLocationId` to `default-warehouse` when omitted, return the updated single-location `StockLevelView`, invalidate the cached availability **post-commit** (ADR-023), lazy-init a missing `StockLevel`, and emit a reserved-surface event (`inventory.stock.received` / `inventory.stock.adjusted`); Adjust also re-fires `inventory.stock.low` (→ notification) when the post-commit on-hand falls at/below the threshold. Each also **appends a `StockMovement` ledger row inside the same counter transaction** — Receive a positive `receipt`, Adjust the signed `adjustment` carrying its `reasonCode` — attributed to the acting staff user (`actorId`, null = system), and emits the per-insert `inventory.stock-movement.recorded` event post-commit. The append runs *after* the version-checked persist, so a lost optimistic-write race never leaves an orphaned ledger row and a retry appends exactly once; the running totals remain the balance authority (the ledger is audit only, ADR-027).

**Transfer** (`inventory:transfer`, body `{ fromLocationId, toLocationId, quantity }` — both locations required) moves on-hand for one variant from one location to another **atomically**: two version-checked `StockLevel` writes + two paired `adjustment` ledger rows in one transaction, returning `{ from, to }` (both post-transfer `StockLevelView`s). The ledger has no `transfer` type — a transfer is a **pair** of `adjustment` rows sharing one `referenceType: 'transfer'` + `referenceId` (a per-transfer UUID): the source leg `−quantity` (`reasonCode: 'transfer-out'`), the destination leg `+quantity` (`reasonCode: 'transfer-in'`); querying that reference pair reconstructs the transfer. A transfer moves **on-hand only** — the source's `quantityReserved`/`quantityAllocated` counters are untouched; transferring more than the source's on-hand is a `409 INVENTORY_STOCK_RESULT_NEGATIVE` (the same below-zero guard Adjust uses), a same-location or bad-quantity request a `400`. It invalidates the cache for **both** locations post-commit, emits `inventory.stock-movement.recorded` per leg, and re-fires `inventory.stock.low` on the source leg exactly like a negative Adjust. In-transit modelling is deferred (a transfer is instantaneous — it records nothing between the two locations). See [docs/implementation/07-inventory-reservation-and-stock-movement/09-transfer-stock-two-movements.md](docs/implementation/07-inventory-reservation-and-stock-movement/09-transfer-stock-two-movements.md).

Four further inventory RPCs handle the **reservation lifecycle**. They are driven by the **retail microservice over RabbitMQ** (reserve on add/change, release on remove, allocate on place — see the retail/cart section); the gateway additionally fronts **Release** over HTTP as the operator manual-release below. **Reserve** (`inventory.reservation.reserve`) holds stock for a cart against the **no-oversell guard** — a request for more than `available` is a `409` carrying `details.available`, and the hold is idempotent-by-absolute-quantity on the `(cartId, variantId, stockLocationId)` triple (re-reserving moves `quantityReserved` by only the delta and refreshes the TTL; a previously released line is reused, never duplicated). **Release** (`inventory.reservation.release`) returns the held units to `available` and appends one negative `release` row to the `stock_movement` ledger per released hold; its selector is either `reservationId` (one row; 404/409) or `cartId` (+ optional `variantId`/`stockLocationId`, all matching active holds; an empty match is an idempotent no-op). **Allocate** (`inventory.reservation.allocate`) converts a cart's active holds into an order's firm allocation at place-time — per line it commits the hold and moves the counter reserved→allocated (refreshing first when the hold is wall-clock-stale-but-still-held), or falls back to a direct allocation against `available` when no hold exists (the request carries the order lines `{ variantId, stockLocationId?, quantity }[]` so the fallback needs no retail read); it is **all-lines-atomic** (a partial allocation never commits) and appends one `allocation` movement per line, returning the per-line `IAllocationResult` (with `reservationId` null on the fallback). **Cancel Allocation** (`inventory.allocation.cancel`) reverses an order's allocation, returning the units to `available` with one `release` movement per line and emitting `inventory.stock.released` (`reason: order-cancelled`); it touches **no** reservation rows, is quantity-guarded (an over-cancel is a `409 STOCK_RESULT_NEGATIVE`), and resolves `{ cancelled }` (the line count). Its callers — the order-cancel flow and the place-failure compensation — arrive in a later capability; the handler ships now as a tested reserved surface. All four run inside the shared bounded optimistic write protocol (version-checked persist, 5-attempt retry, `409` on exhaustion) and emit reserved-surface events (`inventory.stock.reserved` / `.allocated` / `.released` + the per-insert `inventory.stock-movement.recorded`). The hold lifetime is the `RESERVATION_TTL_MINUTES` env var (Joi default `15`). See [docs/implementation/07-inventory-reservation-and-stock-movement/04-no-oversell-invariant-and-occ.md](docs/implementation/07-inventory-reservation-and-stock-movement/04-no-oversell-invariant-and-occ.md) and [06-allocate-on-place.md](docs/implementation/07-inventory-reservation-and-stock-movement/06-allocate-on-place.md).

A fifth order-side RPC, **Commit Sale** (`inventory.stock.commit-sale` → `CommitSaleUseCase`, [ADR-031](docs/adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)), physically ships an order's allocated stock at fulfillment time. The request carries `{ orderId, fulfillmentId, lines[], actorId? }`; per line it decrements **both** `quantityOnHand` and `quantityAllocated` in one `StockLevel.commitSale` (`available` is unchanged — both counters subtract from it; decrementing only on-hand would permanently understate availability) and appends one strictly-negative `sale` movement (`referenceType: 'fulfillment'`, `referenceId: fulfillmentId`) — the `sale` ledger type's first producer. It is **all-lines-atomic** (a partial ship never commits) and **idempotent on `fulfillmentId`**: before any write it probes the ledger's `(reference_type, reference_id)` index (`existsByReference`), and a `sale` row already referencing the fulfillment short-circuits the replay (it re-returns the request's lines, decrements nothing, opens no transaction) — which is what makes the cross-service retry safe (retail drives this **after** its local ship commit, so a transient broker re-delivery must not double-decrement). It runs inside the same `withInvalidation(runWithStockWriteRetry(...))` protocol, emits `inventory.stock.committed` per line + the per-insert `inventory.stock-movement.recorded`, and re-fires `inventory.stock.low` per touched level. It is reached retail → inventory over RabbitMQ (no gateway HTTP route); its retail ship caller — `ShipFulfillmentUseCase`, which calls it **after** the local ship commit through the module-prefixed `ORDER_COMMIT_SALE_GATEWAY` port — is now live (see the retail section). See [docs/implementation/08-fulfillment-and-ship-flow/04-commit-sale-cross-service-rpc.md](docs/implementation/08-fulfillment-and-ship-flow/04-commit-sale-cross-service-rpc.md).

A sixth order-side RPC, **Restock from Return** (`inventory.stock.restock-from-return` → `RestockFromReturnUseCase`, [ADR-032](docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)), is the mirror of Commit Sale for the returns flow: it returns a return request's `restock`-disposition stock to sellable inventory at inspection time. The request carries `{ returnRequestId, lines[], actorId? }` (each line `{ returnLineId, variantId, stockLocationId, quantity }`); per line it raises `quantityOnHand` in one `StockLevel.changeOnHand(+quantity)` (reserved/allocated untouched, so `available` rises by the same amount — no new mutator was needed) and appends one strictly-positive `return` movement (`referenceType: 'return-request'`, `referenceId: returnRequestId`) — the long-dormant `return` ledger type's **first producer**. It is **all-lines-atomic** (a partial restock never commits) and **idempotent on `returnRequestId`**: before any write it probes the ledger's `(reference_type, reference_id)` index (`existsByReference`), and a `return` row already referencing the request short-circuits the replay (it re-returns the request's lines, increments nothing, opens no transaction) — which makes the cross-service retry safe (retail drives this **after** its local inspect commit). It lazy-inits a missing level at the receiving location (a returned variant may have none yet there), runs inside the same `withInvalidation(runWithStockWriteRetry(...))` protocol, emits `inventory.stock.returned` per line + the per-insert `inventory.stock-movement.recorded`, and — unlike Commit Sale — **never re-fires `inventory.stock.low`** (a restock only raises on-hand, so it can't cross the threshold downward). It is reached retail → inventory over RabbitMQ (no gateway HTTP route); its retail Inspect & Disposition caller (`InspectAndDispositionUseCase` via `INVENTORY_RESTOCK_GATEWAY`) is now live. See [docs/implementation/09-returns-and-refunds/02-return-line-disposition-and-restock.md](docs/implementation/09-returns-and-refunds/02-return-line-disposition-and-restock.md).

Two **operator** surfaces front this state over HTTP. The **audit read** (`GET /api/inventory/variants/:variantId/movements` → `inventory.stock-movement.list` → `ListStockMovementsUseCase`, `inventory:read`) returns a paginated, newest-first (`occurred_at DESC, id DESC`) `IPage<StockMovementView>` of one variant's ledger rows, optionally narrowed by `?type` and an inclusive `?from`/`?to` (ISO-8601) `occurredAt` window; an unknown variant is a `200` empty page (the zero-answer convention), and the read is **uncached** (the ledger grows monotonically and an audit query wants the latest rows — caching would add an invalidation hop to every counter-changing write for no hit-rate gain). The **manual reservation release** (`POST /api/inventory/reservations/:reservationId/release`, `inventory:adjust`, no body) rides the existing release RPC with the `reservationId` selector, folding `reason: 'manual'` + the staff `actorId` into the payload — it frees one hold, returns the units to `available`, and writes a `manual`-reason `release` ledger row attributed to the operator (an unknown id is a `404`, an already-released/committed row a `409`). It is the **only operator-reachable hold-freeing tool** until a TTL sweeper lands; an operator sources the `reservationId` from the reserve-path logs, the `inventory.stock.reserved` event, or the DB (there is no reservation list/read endpoint by design). No new permission code was minted — the existing `inventory:read` / `inventory:adjust` cover both (ADR-024). See [docs/implementation/07-inventory-reservation-and-stock-movement/10-movements-audit-endpoint-and-http-file.md](docs/implementation/07-inventory-reservation-and-stock-movement/10-movements-audit-endpoint-and-http-file.md).

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `RESERVATION_TTL_MINUTES` | `15` | Lifetime (minutes) of a stock reservation hold — `expiresAt = now + RESERVATION_TTL_MINUTES` on every Reserve write (Joi-validated positive integer). |
| `RETURN_WINDOW_DAYS` | `30` | Return-eligibility window (days) — a `shipped` order is returnable only within this many days of its ship date; a `delivered` order is always returnable (Joi-validated positive integer, [ADR-032](docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)). |

### Inventory invariants

Three guarantees hold across every inventory operation; the [ADR-030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) capability is built to keep them true under concurrency.

**No-oversell.** `available = quantityOnHand − quantityAllocated − quantityReserved` is a pure getter on `StockLevel`, and **no operation ever lets it go negative**. Reserve and the direct-allocate fallback both check `quantity ≤ available` *before* moving a counter and reject the overflow with `409 INVENTORY_OUT_OF_STOCK` carrying `details.available`; Adjust and Transfer reject an on-hand result below zero with `409 INVENTORY_STOCK_RESULT_NEGATIVE`. The check and the write run **in one transaction** under the shared bounded optimistic-write protocol: read the `stock_level` row (capturing its `version`), mutate in memory, then persist with a version-checked `UPDATE`. A lost compare-and-swap (a concurrent writer bumped the `version` first) throws `StockWriteConflictError` and the whole attempt retries on a fresh transaction, up to `MAX_WRITE_ATTEMPTS = 5`, after which the caller gets `409 STOCK_WRITE_CONFLICT`. This is what makes two carts racing for the last unit deterministic — exactly one reserve wins, the loser sees `available: 0` — and it is locked by `test/concurrent-oversell.e2e-spec.ts` across 5 consecutive runs.

**Reservation TTL.** A `Reservation` is a time-bounded hold: every Reserve write (re)sets `expiresAt = now + RESERVATION_TTL_MINUTES` (default `15`), so an active line keeps refreshing its lease as the shopper edits the cart. Placing an order **commits** the hold inside the place transaction (reserved → allocated; a wall-clock-stale-but-still-held hold is refreshed-then-committed rather than rejected, since its counter is still occupied and therefore oversell-safe). A hold returns to `available` three ways: the cart Remove route **releases** it, Place **allocates** it (after which it is the order's allocation, freed only by a cancel-allocation), or an operator **manually releases** it by id (`POST /api/inventory/reservations/:reservationId/release`). There is **no expiry sweeper yet** — `Reservation.expire()` has no caller — so until that capability lands the manual release is the only tool that reclaims a hold whose owner walked away; a stranded hold over-holds stock but is never lost (the next Reserve on the same triple reuses the row, and a future sweeper will reclaim it).

**Audit, not balance.** The `stock_movement` ledger is an **append-only audit trail, never the balance authority** ([ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md)). The running totals on `stock_level` are the source of truth; the ledger only records *what happened* (one fixed-sign row per counter change — `receipt`/`adjustment`/`allocation`/`release`, etc.), and **summing ledger rows never reconstructs on-hand**. The append is inexpressible as an update or delete (the `STOCK_MOVEMENT_REPOSITORY` port exposes only `append` + `listByVariant`) and runs *after* the version-checked persist in the same transaction, so a lost optimistic-write race leaves no orphan row and a retry appends exactly once. Every counter-changing operation — Receive, Adjust, Transfer, Reserve's Release, Allocate, Cancel — leaves its movement, giving the audit read (`GET /api/inventory/variants/:variantId/movements`) a complete, ordered history.

### Fulfillment flow

A placed order walks to `delivered` through per-shipment `Fulfillment` records ([ADR-031](docs/adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)); these notes describe the happy path and the two cancel paths the way the [inventory invariants](#inventory-invariants) describe the stock guarantees.

**Place → fulfill → ship → deliver.** Placing an order authorizes payment and allocates stock, leaving it `status=pending` / `paymentStatus=authorized` / `fulfillmentStatus=unfulfilled`. An operator then **creates** one or more `Fulfillment`s — each a `pending` shipment of some `OrderLine` quantities from one stock location, with the cross-fulfillment sum per line capped at the ordered quantity. **Shipping** a fulfillment is the pivot that moves money and stock together: it **captures the payment inline** (ship-triggered capture, Q5 — an `authorized` payment is captured through the gateway *before* the local commit, and a decline blocks the ship with `409 ORDER_PAYMENT_NOT_CAPTURED` so nothing is written), advances the fulfillment to `shipped`, flips each shipped line and the order's roll-up `fulfillmentStatus` (`shipped` iff every line is fully shipped, else `partially-shipped`), and **after** the commit calls the cross-service `inventory.stock.commit-sale` to physically decrement on-hand **and** allocated (retried-then-logged, never rolled back; idempotent on `fulfillmentId`, so a replay is safe). **Delivering** the last outstanding fulfillment rolls the order up to `delivered` on both the lifecycle and fulfillment axes.

**Cancel pre-ship voids/releases; cancel post-capture flags for refund.** **Cancel Order** is refused once any fulfillment is `shipped`/`delivered` (`409 ORDER_NOT_CANCELLABLE` — the real shipped-stock guard, since the lifecycle axis stays `pending` after a ship). When it is allowed it cancels the order and its `pending` fulfillments, settles the payment — an `authorized` payment is **voided**, a `captured` one is **flagged for refund** (`flagged_for_refund = true`, consumed by the `OrderCancelledConsumer` → auto Issue Refund — a full refund clears the flag) — and releases the order's stock allocation through `inventory.allocation.cancel` (best-effort, retried-then-logged). **Cancel Line** (staff-only) cancels a single line's **unshipped** quantity and releases just that slice of the allocation, with no money-total change and no event.

**Ship-vs-cancel is serialized by a row lock.** A concurrent ship and cancel of the same order would otherwise both succeed and invert state (`cancelled` + `shipped` at once). Both operations re-read the contended `fulfillment` row `FOR UPDATE` inside their transaction, so the loser blocks until the winner commits and then fails its own precondition — the ship's `pending` guard or the cancel's re-checked no-`shipped`-fulfillment guard. Exactly one wins; strict per-aggregate optimistic-concurrency enforcement on the order is a later hardening. This is locked by `test/concurrent-ship-cancel.e2e-spec.ts`, winner-agnostic and green across 5 consecutive runs.

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
POST   /api/cart/:cartId/lines          # bearer + owner-check — add a priced line (reserves stock; 409 INVENTORY_OUT_OF_STOCK + details.available)
PATCH  /api/cart/:cartId/lines/:lineId  # bearer + owner-check — change quantity (re-reserves; 409 if out of stock)
DELETE /api/cart/:cartId/lines/:lineId  # bearer + owner-check — remove a line (releases the hold best-effort)
POST   /api/cart/:cartId/claim          # bearer — promote a guest cart (fromCustomerId proof; no inventory call)
POST   /api/cart/:cartId/place          # bearer + owner-check — place order (allocates inside the tx; authorize-on-place; Idempotency-Key header)

# Orders (read + capture + fulfillment + cancel)
GET    /api/orders                       # bearer — own orders, paginated, newest-first
GET    /api/orders/:orderId              # bearer — owner OR staff order:read
POST   /api/orders/:orderId/payments/capture  # bearer — owner OR staff order:capture (Idempotency-Key header)
POST   /api/orders/:orderId/fulfillments                       # bearer + order:fulfill — create a shipment (FulfillmentView 201)
GET    /api/orders/:orderId/fulfillments                       # bearer — owner OR staff order:read (FulfillmentView[])
POST   /api/orders/:orderId/fulfillments/:id/ship              # bearer + order:fulfill — ship (captures payment; Idempotency-Key header)
POST   /api/orders/:orderId/fulfillments/:id/deliver           # bearer + order:fulfill — mark delivered
POST   /api/orders/:orderId/cancel                             # bearer — owner OR staff order:cancel — void/flag payment, release allocation
POST   /api/orders/:orderId/lines/:lineId/cancel               # bearer + order:cancel (staff) — cancel a line's unshipped quantity

# Returns (the RMA lifecycle — owner-or-staff Open/reads, staff-only status walk)
POST   /api/orders/:orderId/returns       # bearer — owner OR staff order:return-authorize — open an RMA (ReturnRequestView 201)
GET    /api/orders/:orderId/returns       # bearer — owner OR staff order:read (ReturnRequestView[])
GET    /api/returns/:rmaId                # bearer — owner OR staff order:read (ReturnRequestView)
POST   /api/returns/:rmaId/authorize      # bearer + order:return-authorize — requested → authorized
POST   /api/returns/:rmaId/reject         # bearer + order:return-authorize — requested → rejected ({ reason })
POST   /api/returns/:rmaId/receive        # bearer + inventory:receive-return — authorized → received
POST   /api/returns/:rmaId/inspect        # bearer + inventory:receive-return — received → inspected (per-line disposition; restock re-enters stock)
POST   /api/returns/:rmaId/close          # bearer + order:return-authorize — inspected → closed

# Refunds (order-scoped — staff Issue, owner-or-staff List)
POST   /api/orders/:orderId/refunds       # bearer + order:refund — issue against a captured payment (RefundView 201; Idempotency-Key header)
GET    /api/orders/:orderId/refunds       # bearer — owner OR staff order:read (RefundView[])

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

Swapping in a real gateway (Stripe, Adyen, …) is a **single provider rebind** in `orders.module.ts` (`{ provide: PAYMENT_GATEWAY, useClass: StripePaymentGatewayAdapter }`) plus a new HTTP-doing sibling adapter under `infrastructure/payment-gateway/` that implements the same port. No use case, controller, domain model, or contract changes — the `ClientProxy`/HTTP client stays confined to the new adapter, exactly as the boundaries rules ([ADR-017](docs/adr/017-architecture-lint-via-eslint-boundaries.md)) require. Authorize, capture, void, and **refund** are all live behind the port; a real processor, partial captures, and a gateway `fail` outcome are deliberately excluded from this capability.

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
| `warehouse-staff` | `inventory:read`, `inventory:adjust`, `inventory:transfer`, `inventory:receive-return`, `order:fulfill`, `order:cancel` |
| `order-support` | `order:read`, `order:capture`, `order:fulfill`, `order:cancel`, `order:refund`, `order:return-authorize` |

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

The notification microservice reads three further defaulted variables (all Joi-validated, so a missing value never fails boot):

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `OPS_NOTIFICATIONS_EMAIL` | `ops@example.com` | Ops mailbox for system-only notifications with no customer recipient (e.g. the inventory low-stock alert). |
| `MAX_DELIVERY_ATTEMPTS` | `3` | Max attempts before a notification delivery is abandoned and `notifications.delivery.failed` is emitted. |
| `RETENTION_DELIVERY_DAYS` | `90` | Retention window (days) for delivery rows; the purge worker is a future capability. |

### Local development

`yarn test:seed` (or `yarn test:infra:reload`) inserts argon2id-hashed users — four staff (one per canonical role) and one customer:

| Email | Password | Role | Type |
| --- | --- | --- | --- |
| `admin@example.com` | `admin1234` | `admin` | StaffUser |
| `catalog@example.com` | `catalog1234` | `catalog-manager` | StaffUser |
| `warehouse@example.com` | `warehouse1234` | `warehouse-staff` | StaffUser |
| `support@example.com` | `support1234` | `order-support` | StaffUser |
| `customer@example.com` | `customer1234` | — | Customer |

The same seed loads a small **catalog + pricing** fixture so the catalog read paths and the publish precondition return seeded answers. Two products carry four variants; each variant has one open `USD` price; three tax categories exist as classification labels (none attached to a variant by default). A small **category tree** and two **media assets** on product 1 round out the navigation surface so the browse/tree reads and the media strip return seeded answers from a cold start.

Catalog products → variants:

| Variant id | SKU | Product (slug) | Status |
| --- | --- | --- | --- |
| 1 | `AURORA-WARM` | `aurora-desk-lamp` | active |
| 2 | `AURORA-COOL` | `aurora-desk-lamp` | active |
| 3 | `NIMBUS-BLACK` | `nimbus-office-chair` | active |
| 4 | `NIMBUS-GREY` | `nimbus-office-chair` | active |

Categories (`category` — a materialized-path hierarchy; two roots and one child):

| id | Name | Slug | Parent | `path` | Sort |
| --- | --- | --- | --- | --- | --- |
| 1 | Electronics | `electronics` | — | `/electronics` | 0 |
| 2 | Phones | `phones` | 1 (`electronics`) | `/electronics/phones` | 0 |
| 3 | Apparel | `apparel` | — | `/apparel` | 1 |

Product ↔ category memberships (`product_categories` — the bare N↔M join):

| Product (slug) | Category (slug) |
| --- | --- |
| 1 (`aurora-desk-lamp`) | 1 (`electronics`) |
| 1 (`aurora-desk-lamp`) | 2 (`phones`) |

So `GET /api/catalog/categories/electronics/products?includeDescendants=true` returns product 1 — directly under `electronics` and via the `phones` descendant.

Media assets (`media_asset` — polymorphic; two on product 1, ordered):

| id | Owner | `type` | `sort_order` | `uri` |
| --- | --- | --- | --- | --- |
| 1 | product 1 | image | 0 | `https://cdn.example.com/aurora-desk-lamp/front.jpg` |
| 2 | product 1 | video | 1 | `https://cdn.example.com/aurora-desk-lamp/demo.mp4` |

So `GET /api/catalog/products/1/media` returns the image then the video. The `uri` host is illustrative — media URIs are opaque, already-uploaded references (no upload pipeline; [ADR-029](docs/adr/029-category-materialized-path-and-polymorphic-media.md)).

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

`scripts/seeds/stock-location.sql` adds a **second** active `StockLocation` — `backup-store` (a `store`-type location, no stock seeded) — so Transfer Stock has a destination on a freshly seeded database (`INSERT IGNORE`, registered before `stock-level.sql`). A transfer (`POST /api/inventory/variants/:variantId/stock/transfer`) is what moves on-hand there.

The seed also loads one **example cart** for the seeded customer so `GET /api/cart/:cartId` returns a populated cart on a cold start (the `http/cart.http` and e2e flows build their own carts, so this row is purely a development convenience):

| Cart id | Customer | Currency | Status | Line |
| --- | --- | --- | --- | --- |
| `00000000-0000-4000-d000-000000000001` | `customer@example.com` | `USD` | `active` | variant 1 ×2 @ `4999` (snapshot) |

`scripts/seeds/cart.sql` runs last (idempotently — the cart row is `INSERT IGNORE` on its UUID, the line is a `WHERE NOT EXISTS` guarded insert on the `(cart_id, variant_id)` pair so it never collides with an e2e-built line's auto-increment id): the cart FKs the seeded `customer` (loaded by the identity pass, which the seed runs **before** the SQL fixtures), and the line FKs `product_variant` and snapshots variant 1's seeded USD price. The cart id uses the `...-d000-...` (carts) namespace, alongside the `a000` (users) / `b000` (permissions) / `c000` (roles) prefixes.

The `order:capture` permission is seeded (id `...-b000-00000000000e`) and bound to the `order-support` and `admin` roles — it is the staff override on `POST /api/orders/:orderId/payments/capture` (the owning customer needs no permission, only ownership).

Every catalog / category / membership / media / pricing / stock / cart seed row uses a fixed id and `INSERT IGNORE` (the membership row, having no surrogate id, is `INSERT IGNORE` on its composite `(product_id, category_id)` PK), so re-running `yarn test:seed` is idempotent (no duplicate rows, no error). Each price carries a fixed *past* `valid_from`, so `GET /api/catalog/variants/:variantId/price?currency=USD` returns the seeded row for variants 1–4 immediately after a seed. The seed SQL files apply in FK-safe order (`scripts/utils/test-db-seed.util.ts`): `category.sql` → `product-categories.sql` → `media-asset.sql` follow `catalog-product(-variant).sql` because the membership FKs both the product and the category.

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

Under the previous inventory model the value was a `SUM(quantity) ... GROUP BY storageId` aggregate over an append-only `product_stock` ledger keyed on `productId`, whose cost grew linearly with movement history. The running-totals rewrite ([ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md)) keeps `quantityOnHand` / `quantityAllocated` / `quantityReserved` as maintained counters on one `stock_level` row per `(variantId, stockLocationId)`, so a read is now a constant-cost point lookup. The cache-aside **mechanism** is unchanged (ADR-002 → ADR-006 → ADR-016 → ADR-021 → ADR-022 → ADR-023); the cached **value shape** and the **key axis** (`productId` → `variantId`) changed in the [`v1 → v2` bump](docs/implementation/04-inventory-stock-level-and-location/04-cache-key-bump-v1-to-v2.md), and the value's **meaning** changed in the [`v2 → v3` bump](docs/implementation/07-inventory-reservation-and-stock-movement/07-cache-key-bump-v2-to-v3.md) — once TTL'd reservations move `quantityReserved`, the same `VariantStockView` field set reflects holds a `v2` reader never knew about ([ADR-030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) §7). The full read path is documented in [the availability read path](docs/implementation/04-inventory-stock-level-and-location/07-availability-read-path.md).

The cache layer follows the conventions formalized in [ADR-016](docs/adr/016-cache-aside-generalized.md): every cache key is built via `CACHE_KEYS.*` (no string literals in `apps/*/src`), and apps depend on `ICachePort` rather than `@nestjs/cache-manager` directly.

### What is not cached

Only the per-variant availability read is cached today. The location list (`GET /api/inventory/locations` → `ListLocationsUseCase`) is **not** cached — it is a small, slow-changing set, and the gateway adds no caching of its own. The catalog browse/resolve reads, the **category** navigation reads (`catalog.category.list` / `.get-tree` / `.list-products`), and the **pricing** reads (`catalog.price.select` / `catalog.price.list` and their gateway routes) deliberately go straight to MySQL on every call — their read volume has not crossed the threshold where cache-aside complexity (key versioning plus post-commit invalidation on every write) pays for itself. The key shapes are already reserved for when they do: `CACHE_KEYS.catalogPrice(variantId, currency)` builds `ris:catalog:price:v1:<variantId>:<currency>`, and the category navigation builders `CACHE_KEYS.catalogCategoryTree()` / `catalogCategoryChildren(categoryId)` build `ris:catalog:category-tree:v1` (a singleton — the whole tree) and `ris:catalog:category:v1:<categoryId>:children` (mirroring the stock keys and the reserved `catalogProduct*` block) — versioned and ready, but no catalog/pricing module imports `CacheModule` for them yet. Caching these reads is a later capability gated on measured read pressure, not a missing feature.

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
ris:inventory:stock:v3:<variantId>:__all__                         # no locationIds filter
ris:inventory:stock:v3:<variantId>:<locationIds-joined-by-comma>   # e.g. ris:inventory:stock:v3:42:backup-store,default-warehouse
```

Stock-location ids are sorted with `localeCompare` so callers passing the same set in different orders generate identical keys (`__all__` is the sentinel for an unscoped, aggregate-across-all-locations read). The `v3` segment is the per-aggregate schema-version constant (`INVENTORY_STOCK_KEY_VERSION` in `libs/cache/cache-keys.ts`); it was bumped `v1 → v2` when the cached value reshaped from the per-product `SUM` aggregate to the per-variant `VariantStockView` projection (the key axis moving `productId` → `variantId`, [ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md)), then `v2 → v3` when TTL'd reservations started moving `quantityReserved` so the same field set carries a new meaning ([ADR-030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) §7) — pre-bump entries became unreachable and age out via TTL. Built by `CACHE_KEYS.inventoryStock(variantId, stockLocationIds?, opts?)`; an optional `{ tenantId }` argument prefixes the key with `t:<tenantId>:` for future multi-tenant use (omitted entirely when absent — never defaulted). Four legacy prefixes are still wiped by the SCAN-based invalidate path so a rolling deploy can sweep entries written under the pre-v3 (`ris:inventory:stock:v2:<id>:`), pre-v2 (`ris:inventory:stock:v1:<id>:`), pre-v1 (`ris:inventory:stock:<id>:`), and pre-ADR-016 (`stock:<id>:`) conventions.

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

Invalidation issues **five** `delByPrefix` calls per affected `variantId` during the transition window (the current `v3` prefix, the pre-v3 `inventoryStockLegacyPrefixV2` = `ris:inventory:stock:v2:<variantId>:`, the pre-v2 `inventoryStockLegacyPrefixV1`, the pre-v1 `inventoryStockLegacyPrefix`, and the pre-ADR-016 `productStockPrefix` — see [ADR-022](docs/adr/022-cache-keys-tenant-and-schema-version.md) §4 and [ADR-030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) §7). Each `delByPrefix` does `SCAN MATCH <prefix>*` and `UNLINK`s every matching key. `UNLINK` (vs `DEL`) frees memory asynchronously on the Redis side, avoiding a blocking O(N) delete on Redis's main thread.

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
redis-cli --scan --pattern 'ris:inventory:stock:v3:*'

# Read a specific entry (variant 1, aggregated across all locations)
redis-cli GET 'ris:inventory:stock:v3:1:__all__'

# Check remaining TTL (in ms) for a key
redis-cli PTTL 'ris:inventory:stock:v3:1:__all__'

# Manually invalidate every cached entry for a single variant
redis-cli --scan --pattern 'ris:inventory:stock:v3:1:*' | xargs -r redis-cli UNLINK
```

See [ADR-002](docs/adr/002-redis-cache-aside-product-stock.md) for the original design, [ADR-016](docs/adr/016-cache-aside-generalized.md) for the generalized key convention + port-based invalidation, [ADR-027](docs/adr/027-stocklevel-running-totals-and-stocklocation.md) for the `StockLevel` projection the value carries, and [ADR-030](docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) §7 for the `v2 → v3` reservation-semantics bump.
