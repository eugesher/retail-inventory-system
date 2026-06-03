# 01 — The pricing module scaffold

This document records standing up `pricing` as a second bounded context **inside
the existing `catalog-microservice`**, alongside the `catalog` module. At this
stage the module is intentionally inert: it is a valid, bootable Nest module with
the canonical four-layer hexagonal folder skeleton in place but no providers,
entities, or handlers yet. Its domain (`Price` / `TaxCategory`), persistence, use
cases, events, and controller arrive in the documents that follow this one.

In the same change two pieces of housekeeping land so the scaffold is consistent
with the rest of the system: the shared permission registry gains a
`pricing:write` code (seeded into the roles that will use it), and an obsolete
placeholder the catalog publish use case carried — a *warn-and-proceed* stand-in
for a future price precondition — is removed now that pricing is a real place that
will own the precondition.

The code lives under `apps/catalog-microservice/src/modules/pricing/`. The
decisions it honors are
[ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) (per-module
hexagonal layout), [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)
(architecture lint), [ADR-018](../../adr/018-nestjs-monorepo-apps-and-libs.md)
(the NestJS monorepo), [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
(the permission-code registry), and [ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)
(the catalog aggregate, which defines `variantId` as the backbone key pricing
keys on).

## 1. Why a sibling module, not a new microservice

Pricing could have been a fifth deployable. It is not, and the reason is bounded
contexts and the cost of a network hop:

- **Pricing colocates with catalog by domain.** A price is attached to a
  **`ProductVariant`** — the sellable, stocked, priced unit
  ([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md) §1). Pricing
  reads and reasons about the same merchandisable graph the catalog module owns.
  Splitting them into separate deployables would put a RabbitMQ round-trip between
  "this variant exists" and "this variant costs X" on the hot path for no
  isolation benefit — they are authored by the same people (catalog managers) and
  change for related reasons.
- **`variantId` is the shared backbone key, not a shared aggregate.** ADR-025
  records `variantId` as the forward backbone key: inventory stock, pricing, and
  order lines all address the **variant**, not the product. Pricing therefore
  needs only the opaque `variantId` to do its job — it never reaches into the
  catalog `Product`/`ProductVariant` domain. Colocating the two modules in one
  service does **not** dissolve that boundary: it is held by the module-isolation
  lint rules (§3), exactly as it would be across a service boundary.
- **The RPCs ride the existing `catalog_queue`.** A new deployable means a new
  queue, a new `MicroserviceClient*` module, a new container, and new compose
  wiring. A sibling module reuses the catalog service's RMQ transport: pricing's
  future `@MessagePattern` handlers listen on the same `catalog_queue` the catalog
  controller already uses, and the gateway proxies them over the same client. One
  service, two modules, one queue.

This mirrors how the API gateway already hosts two stateful modules side by side —
`auth` and `iam` ([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)) —
rather than splitting every bounded context into its own process.

## 2. The per-module hexagonal skeleton

The module follows the per-module hexagonal layout every service in this
repository uses ([ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md)),
with the **one divergence the catalog module also takes**: the Nest module file
sits at the module root, not under `infrastructure/`.

```
apps/catalog-microservice/src/modules/pricing/
  domain/                       # Price / TaxCategory model, VOs, lifecycle enums, events
  application/
    ports/                      # repository port + events-publisher port (+ DI symbols)
    use-cases/                  # set / schedule / select price + tax-category use cases
  infrastructure/
    persistence/                # Price / TaxCategory entities, mappers, repository adapter
    messaging/                  # the RabbitMQ events-publisher adapter (sole ClientProxy holder)
  presentation/                 # PricingController with its @MessagePattern handlers
  pricing.module.ts             # module root (mirrors catalog.module.ts's location)
  index.ts                      # barrel: exports PricingModule + the pricingEntities seam
```

Each folder is created now even though most are empty, because **git does not
track empty directories**. Each empty layer carries a barrel `index.ts` that
re-exports nothing yet (a bare `export {};` so the file is a valid ES module with
a self-documenting header comment). A barrel that re-exports nothing is harmless
to the architecture lint — `**/index.ts` is excluded from the boundaries
dependency graph (§3) — so its only job today is to keep the folder on disk at the
canonical path. The moment a real file lands in a layer, the generic lint rules
classify it correctly with no further setup.

### `pricing.module.ts` — minimal but valid

`PricingModule` is an empty `@Module({})` today. It deliberately does **not** import
`DatabaseModule.forFeature([])`: an empty `forFeature` would be noise standing in
for entities that do not exist. Providers, the `forFeature` entity registration,
the controller, and the `MicroserviceClientCatalogModule` import (for the
`catalog_queue` `ClientProxy` the events publisher will need) all arrive together
with the pricing domain and use cases.

### `index.ts` and the `pricingEntities` seam

The module-root barrel exports two things:

- `PricingModule` — re-exported from `./pricing.module`.
- `pricingEntities` — `export const pricingEntities: EntityClassOrSchema[] = [];`

`pricingEntities` is the seam the service's composition root consumes. The catalog
service runs **one** MySQL connection, registered once at the app level. Its
`app/app.module.ts` now reads:

```ts
DatabaseModule.forRoot([...(catalogEntities ?? []), ...pricingEntities]),
```

so the single `forRoot` aggregates the entities of both colocated modules. The
array is empty today — pricing owns no persistence yet — and gains the `Price` /
`TaxCategory` entities when they land, **without touching `app.module.ts` again**.
Typing it as a concrete `EntityClassOrSchema[]` (never `undefined`) keeps the
spread well-typed under `strictNullChecks`; `catalogEntities` is typed as the
looser `TypeOrmModuleOptions['entities']` (which may be `undefined`), hence the
`?? []` guard on its half of the spread.

## 3. Boundaries — same rules, no config change

The architecture-lint rules in `eslint.config.mjs`
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)) are expressed
**generically**: element types are matched by glob patterns such as
`apps/*/src/modules/*/domain/**` with `capture: ['app', 'module']`, not by
hard-coded per-service or per-module paths. A new sibling module placed at the
canonical paths is therefore classified automatically — its `domain/`,
`application/{ports,use-cases}/`, `infrastructure/`, and `presentation/` layers
inherit the same per-layer import denylists as every other module, **with no new
rule and no new entry**. The lint config is unchanged by this work; adding a
pricing-specific rule would be wrong.

The companion to the production config is the fixture suite in
`spec/architecture-lint.spec.ts`, which re-asserts that each rule actually fires
so the config cannot be silently weakened. This change adds a
`boundaries/dependencies — pricing module` block mirroring the catalog block:
pricing `domain` may not import `@nestjs/common` or `typeorm`; pricing
`application/use-cases` may not import `typeorm` or `@nestjs/typeorm`; pricing
`application/ports` may not import `typeorm`; pricing `presentation` may not import
`@retail-inventory-system/database`.

### The pricing ↔ catalog domain isolation

The most load-bearing fixture is the **cross-module bumper**. Pricing and catalog
share a process, but their domains must stay isolated: pricing addresses a variant
by the opaque **`variantId`** and must never import a catalog domain type. The
fixture injects

```ts
import { Product } from '../../catalog/domain/product.model';
```

at a `pricing/domain/__fixture__.ts` path and asserts `boundaries/dependencies`
fires. Because that import resolves to a real file, the boundaries resolver types
the target as catalog's `domain` element; the per-module allow rule
(`sameModule('domain')`) requires the **same app and the same module**, so a
pricing→catalog domain edge is cross-module and disallowed. This locks the
isolation in code, not just in prose — the same protection module isolation gives
across a service boundary, applied to two modules in one service.

## 4. The `pricing:write` permission code

Authorization in this system is permission-code-first
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)): the
`PermissionCodeEnum` in `libs/contracts/auth/permission.enum.ts` is the **single
source of truth** for permission codes, inflated into the access JWT as a
`permissions: string[]` claim and read by `@RequiresPermission(<code>)` at the
gateway. Pricing's future write routes (set/schedule a price, manage tax
categories) need a code, so this change adds:

```ts
PRICING_WRITE = 'pricing:write',
```

It matches the registry's `^[a-z][a-z-]*:[a-z][a-z-]*$` shape. No route is gated
by it yet — the gateway pricing routes are later work — but the code exists in the
single source of truth so that work has it to reference.

### The enum ↔ seed coupling

The enum and the seed are coupled by construction, and that coupling is a feature.
`scripts/test-db-seed.ts` builds the `admin` role from
`Object.values(PermissionCodeEnum)` and resolves each code's row id from a
`PERMISSION_SEEDS` table. **Adding an enum value without a matching
`PERMISSION_SEEDS` row throws** `seedRoles: missing permission id for code …` —
the seed refuses to run with a code it cannot resolve. So this change lands the
row in the same commit:

- a `PERMISSION_SEEDS` row `{ id: '00000000-0000-4000-b000-00000000000d', code:
  PRICING_WRITE, description: 'Set or schedule prices and manage tax categories' }`
  (continuing the `…-b000-…` permission-namespace UUID sequence after `audit:read`
  at `…000c`), and
- `pricing:write` added to the **`catalog-manager`** role's permission list. The
  same people who author and publish the catalogue set its prices.

The **`admin`** role picks the code up automatically through
`Object.values(PermissionCodeEnum)` — it is listed explicitly **only** for
`catalog-manager`, never duplicated under `admin`. The seed stays idempotent
(`INSERT IGNORE` on the permission, role, and `role_permissions` rows), so
re-running it neither errors nor duplicates rows.

## 5. Removing the publish-price placeholder

Before pricing existed, the catalog publish use case carried a **placeholder** for
a precondition it could not yet enforce. `PublishProductUseCase` logged a `warn`
(`active price precondition not yet enforced — pricing capability pending`) where a
"the product has ≥1 active Price" check would eventually live, then proceeded to
publish anyway. It was a deliberate *warn-and-proceed* seam: a marker that the
real rule was owed, placed so the eventual check would slot in without reshaping
the flow.

Now that pricing is a real module that will **own** that precondition, the
placeholder is obsolete and is **deleted, not renamed**. Leaving a renamed or
disabled stand-in would mean two descriptions of the same rule — the marker and
the real thing — and the marker would rot. So the removal is total:

- the multi-line precondition-seam comment and the `this.logger.warn(...)` call are
  gone from
  `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts`;
  the `product.publish()` transition (the domain's ≥1-variant rule), the
  persistence, the event drain, and the best-effort publish are untouched;
- the `'warns that the active-price precondition is deferred and still proceeds'`
  test is removed from the use-case spec — the remaining tests (happy publish +
  emit, no-variant rejection, not-found rejection, best-effort publish failure)
  stay green;
- the references the removal left dangling are fixed in the same change: the
  message-pattern note in `CLAUDE.md` and the publish passages in the sibling
  catalog docs
  ([05 — Catalog use cases](../02-catalog-product-and-variant/05-catalog-use-cases.md)
  and
  [03 — The `Product` and `ProductVariant` domain](../02-catalog-product-and-variant/03-product-and-variant-domain.md))
  now state the current truth: `PublishProductUseCase` enforces only the
  ≥1-variant rule, and the active-Price publish precondition is **owned by the
  pricing capability**.

This change removes the placeholder; it does **not** add a price check. The publish
path is, for now, exactly the ≥1-variant rule and nothing more. Wiring the real
active-Price precondition into publish — a hard fail, not a warn — is enforcement
the pricing capability adds once it owns a `Price` to check against. ADR-025's
forward-looking discussion of the precondition stays as the historical record it
is; the live decision is recorded with the pricing domain.

## What this does not do

This is the scaffold only. There is **no** `Price` or `TaxCategory` domain model,
entity, mapper, or migration yet; **no** pricing use case, event, routing key, or
controller handler; **no** gateway pricing routes or `.http` file; and **no** real
active-Price publish enforcement. `PricingModule` is an empty `@Module({})`,
`pricingEntities` is an empty array, and the only behavioural change anywhere is
the deletion of the catalog publish placeholder. Each of those pieces lands in its
own document as the pricing context grows.
