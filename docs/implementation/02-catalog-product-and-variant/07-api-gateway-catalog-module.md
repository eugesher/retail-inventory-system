# 07 — API-gateway catalog module

This document records how the catalog operations are exposed over HTTP at the
API gateway. The catalog microservice already handles seven RPCs over
`catalog_queue` (four write commands + three read queries — see
[05 — Catalog use cases](./05-catalog-use-cases.md)); this change adds the HTTP
surface that fronts them at `apps/api-gateway/src/modules/catalog/`.

The module mirrors the existing `retail/` and `inventory/` gateway modules and
honors three standing decisions:

- [ADR-009 (port/adapter split at the gateway)](../../adr/009-port-adapter-at-the-gateway.md)
  — per-module hexagonal layout, modules named after the downstream service, and
  `ClientProxy` confined to a single messaging adapter.
- [ADR-010 (JWT + RBAC at the gateway)](../../adr/010-jwt-rbac-at-the-gateway.md)
  — every route is bearer-protected by default; opt out with `@Public()`.
- [ADR-024 (RBAC v2 — StaffUser/Customer + permissions)](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
  — gate endpoints with `@RequiresPermission(<PermissionCodeEnum>)`; customer
  tokens carry no `permissions` claim.

## 1. Module shape — mirroring `retail/` and `inventory/`

```
apps/api-gateway/src/modules/catalog/
  application/
    ports/
      catalog-gateway.port.ts     # ICatalogGatewayPort + CATALOG_GATEWAY_PORT
    use-cases/
      register-product.use-case.ts
      add-variant.use-case.ts
      publish-product.use-case.ts
      archive-product.use-case.ts
      list-products.use-case.ts
      get-product.use-case.ts      # by slug
      get-variant.use-case.ts
  infrastructure/
    messaging/
      catalog-rabbitmq.adapter.ts  # the ONLY ClientProxy holder
  presentation/
    catalog.controller.ts          # the seven HTTP routes
    dto/                            # request + query DTOs (class-validator)
  catalog.module.ts                # binds CATALOG_GATEWAY_PORT -> adapter
```

Like the other gateway modules — and unlike the `auth` module — the catalog
module has **no `domain/`**: the gateway holds no catalog state, it only
translates HTTP into RPC (ADR-009). The dependency direction is
`presentation → application (use-cases → port) → infrastructure (adapter)`; the
controller and use cases never see `@nestjs/microservices`.

`catalog.module.ts` sits at the module root (as `inventory.module.ts`,
`retail.module.ts`, `auth.module.ts`, and `iam.module.ts` all do), imports
`MicroserviceClientCatalogModule` from `@retail-inventory-system/messaging` (the
`catalog_queue` `ClientProxy` registration), registers the seven thin use cases,
and binds `CATALOG_GATEWAY_PORT → CatalogRabbitmqAdapter`. It is registered in
the gateway `AppModule` alongside the other downstream modules.

## 2. The `ClientProxy`-in-adapter-only boundary

`CatalogRabbitmqAdapter` (`infrastructure/messaging/`) is the **only** file in
the module that imports `ClientProxy`. It implements `ICatalogGatewayPort` and
materializes every RPC with `firstValueFrom(client.send(ROUTING_KEYS.CATALOG_*,
{ ...payload, correlationId }))` — the same shape `InventoryRabbitmqAdapter`
uses. The dotted routing keys (`catalog.product.register`, …) come from
`ROUTING_KEYS`, never from the legacy `MicroserviceMessagePatternEnum`
([ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md)).

The port (`application/ports/catalog-gateway.port.ts`) declares its inputs as
**business-shaped command/query interfaces** (`IRegisterProductCommand`,
`ICreateVariantCommand`, `IListProductsCommand`) that deliberately omit
`correlationId`. The correlation id is a transport concern threaded as a
separate argument and stitched onto the wire payload inside the adapter — the
same split `IGetProductStockQuery` follows in the inventory module. The port's
**responses** are the catalog wire view DTOs from `@retail-inventory-system/contracts`
(`ProductView`, `ProductVariantView`, `ProductWithVariantsView`,
`VariantWithProductView`, and the paginated `IPage<ProductWithVariantsView>`), so
the HTTP layer surfaces the catalog's own view shapes unchanged.

This is why the boundaries lint ([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md))
stays green: the only transport import lives where the rules permit it.

## 3. The seven-endpoint surface

The controller is mounted at `@Controller('catalog')`; with the gateway's `api`
global prefix the routes are under `/api/catalog`.

| Method | Path | Body / query | Auth | Success |
|---|---|---|---|---|
| `POST` | `/products` | `{ name, slug, description? }` | `@RequiresPermission(CATALOG_WRITE)` | `201` `ProductView` (`status: 'draft'`) |
| `POST` | `/products/:productId/variants` | `{ sku, gtin?, optionValues, weightG?, dimensionsMm? }` | `@RequiresPermission(CATALOG_WRITE)` | `201` `ProductVariantView` |
| `POST` | `/products/:productId/publish` | — | `@RequiresPermission(CATALOG_PUBLISH)` | `200` `ProductView` (`status: 'active'`, `publishedAt`) |
| `POST` | `/products/:productId/archive` | — | `@RequiresPermission(CATALOG_WRITE)` | `200` `ProductView` (`status: 'archived'`, `archivedAt`) |
| `GET` | `/products` | `?status=&page=&pageSize=&search=` | `@Public()` | `200` `IPage<ProductWithVariantsView>` |
| `GET` | `/products/:slug` | — | `@Public()` | `200` `ProductWithVariantsView` |
| `GET` | `/variants/:variantId` | — | `@Public()` | `200` `VariantWithProductView` |

Each route resolves a `correlationId` via `@CorrelationId()`, delegates to its
use case, and returns the use case's value. `:productId` / `:variantId` parse
through `ParseIntPipe`; no presentation pipe is needed because nothing has to be
loaded before the controller runs (contrast the retail `OrderConfirmPipe`).

**Why `POST … /publish` and `… /archive` return `200`, not `201`.** Register and
add-variant create a resource, so they keep `@Post`'s default `201`. Publish and
archive are state transitions on an existing product — they return the current
representation, not a freshly created one — so they carry `@HttpCode(200)`.

The seven thin use cases each inject `CATALOG_GATEWAY_PORT`, assign
`correlationId` to the logger, call the port inside a `try`, and funnel failures
through `throwRpcError` (see §6). They hold no business logic — that lives in the
catalog microservice — they exist so the controller depends on an application
service rather than reaching straight into the adapter, matching
`GetProductStockUseCase` in the inventory module.

## 4. Permission gating and why customers can't write

All gateway routes are protected by default by the global guard chain
`JwtAuthGuard → RolesGuard → PermissionsGuard` (ADR-010 / ADR-024). The catalog
routes split cleanly along the read/write line:

- **Write routes** carry `@RequiresPermission(<code>)`:
  - `catalog:write` for **register**, **add-variant**, and **archive** — the
    content-authoring mutations.
  - `catalog:publish` for **publish** — promoting a product into the live
    catalogue is the higher-trust action, so it gets its own code. A role may
    hold `catalog:write` without `catalog:publish`.
- **Read routes** carry `@Public()` so an unauthenticated shopper can browse the
  catalogue. The browse/resolve surface is the Customer-facing read path
  ([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)): public
  by design.

The permission codes are drawn from `PermissionCodeEnum`
(`@retail-inventory-system/contracts`) — never hard-coded strings (ADR-024).

**Customer tokens cannot reach the write routes by construction.** A write route
is *not* `@Public()`, so `JwtAuthGuard` requires a valid bearer token (401
otherwise). `PermissionsGuard` then requires the demanded code in the request
subject's `permissions` claim. Staff access tokens are inflated with the union
of their roles' permission codes at login/refresh; **customer access tokens
carry no `permissions` claim at all**. So a customer presenting a valid token
fails the permission check with `403` — there is no catalog permission a
customer could ever hold. The negative case is exercised end-to-end with the
seeded `warehouse@example.com` staff user, whose `warehouse-staff` role bundles
only `inventory:*` codes: it gets `403` on both register and publish.

## 5. Edge validation

Request bodies and the list query are validated at the edge with
`class-validator` DTOs under `presentation/dto/`, enforced by the gateway's
global `ValidationPipe` (`whitelist`, `transform`, `forbidNonWhitelisted`):

- `RegisterProductRequestDto` — `name` (1–255), `slug` (kebab-case regex),
  optional `description`.
- `CreateVariantRequestDto` — `sku` (1–255), optional `gtin`, `optionValues`
  (object), optional `weightG` (≥0 int), optional `dimensionsMm` (nested
  non-negative-int VO). The owning `productId` comes from the route param, not
  the body.
- `ListProductsQueryDto` — optional `status`, `page`/`pageSize` (coerced to
  positive ints via `transform`), `search`. The page-size **cap** is owned by
  the downstream `ListProductsUseCase` (it caps at 100), so the gateway only
  enforces the positive-integer floor.

These are a fast-fail convenience: the catalog domain re-validates every
invariant (`Product`/`ProductVariant` and the `OptionValues` / `Dimensions`
value objects), so a request that slips past the edge is still rejected
authoritatively downstream.

## 6. Error propagation

The use cases wrap the port call and translate a failed RPC into an HTTP
exception via the shared `throwRpcError` helper (`common/utils`), exactly as the
retail and inventory gateway use cases do. When a downstream handler rejects with
a structured `RpcException({ statusCode, message })`, `throwRpcError` re-throws
the matching `NotFoundException` / `BadRequestException`; anything else becomes a
`500`.

Note the current downstream behavior: the catalog microservice's write/read use
cases throw a `CatalogDomainException` (a plain `DomainException`, not an
`RpcException`). NestJS's RMQ transport flattens any non-`RpcException` error to
`{ status: 'error', message: 'Internal server error' }` on the wire, so the typed
`CatalogErrorCodeEnum` does not survive the process boundary and a domain
rejection (e.g. a duplicate slug, or publishing a variant-less product) currently
surfaces at the gateway as a `500`. The gateway seam is already in the right
shape to map those precisely (`PRODUCT_NOT_FOUND` → 404, `*_TAKEN` → 409,
invariant/transition codes → 400) the moment the catalog microservice raises a
structured `RpcException` carrying the status — the same pattern the retail
`OrderConfirmPipe` already uses for its not-found rejection. None of the
happy-path or permission flows are affected.

## 7. Verification

```bash
yarn lint                 # --max-warnings 0, exit 0
yarn test:unit            # unchanged — the gateway module is covered by e2e
yarn build                # 5 apps compile

# End-to-end through the gateway (fresh infra reload → migrate → seed → tests):
yarn test:e2e             # test/catalog.e2e-spec.ts green
```

`test/catalog.e2e-spec.ts` boots the catalog microservice + the gateway in
process and drives the full arc: admin registers a draft product, appends two
variants, publishes it, an anonymous client browses/resolves it (list, by-slug,
by-variant), admin archives it, and the anonymous browse no longer lists it. The
permission gates assert `403` for the no-catalog-permission staff user on both a
write and the publish route, `401` for an unauthenticated write, and `200` for
the unauthenticated public browse.
