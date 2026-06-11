# Category & Media — the gateway HTTP API

The catalog microservice exposes its `Category` hierarchy and polymorphic
`MediaAsset` entirely over RabbitMQ (ten RPC keys, documented in
[`01-category-hierarchy-and-materialized-path.md`](01-category-hierarchy-and-materialized-path.md),
[`02-product-categories-join.md`](02-product-categories-join.md), and
[`03-media-asset-polymorphism.md`](03-media-asset-polymorphism.md)). This
document covers the **HTTP edge** that fronts them: twelve routes under
`/api/catalog`, added to the existing gateway catalog module as two new
controllers, eleven thin use cases, the request/query DTOs, and ten new methods
on the catalog gateway port + its RabbitMQ adapter.

After this change the whole category/media capability is reachable with `curl` —
no RPC client needed.

## Where it lives

The gateway is a **thin RPC front** ([ADR-009](../../adr/009-port-adapter-at-the-gateway.md)):
the only holder of a `ClientProxy` is
`infrastructure/messaging/catalog-rabbitmq.adapter.ts`; controllers and use cases
depend on the port symbol `CATALOG_GATEWAY_PORT`, never on `@nestjs/microservices`.
The new work slots into the existing `apps/api-gateway/src/modules/catalog/`
module rather than a new one — `Category` and `MediaAsset` are catalog
aggregates, served by the same `catalog_queue`, so they front through the same
gateway seam as products and prices.

Each aggregate gets its **own controller file**, one-aggregate-shaped, all three
sharing the `catalog` route prefix (the auth module's multi-controller-per-prefix
precedent):

- `presentation/catalog.controller.ts` — products + pricing (unchanged).
- `presentation/category.controller.ts` — the seven category routes (**new**).
- `presentation/media.controller.ts` — the five media routes (**new**).

The use cases are **thin pass-throughs**: each injects `CATALOG_GATEWAY_PORT`,
logs with the `correlationId`, calls the matching port method, and funnels any
RPC error through the shared `throwRpcError` helper (which maps the
microservice's `{ statusCode }` envelope to the right Nest HTTP exception). The
gateway holds **no category/media logic of its own** — every invariant lives in
the catalog domain, and the typed `CATEGORY_*` / `MEDIA_*` rejection codes
surface as `400`/`404`/`409` unchanged.

## The twelve endpoints

`@baseUrl` is `http://localhost:3000/api`. "Auth" is the gate: `catalog:write`
means `@RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)` + `@ApiBearerAuth()`;
`public` means `@Public()` (no token required).

### Category routes (`category.controller.ts`)

| # | Method & path | Body / query | Auth | Response (status) |
|---|---|---|---|---|
| 1 | `POST /catalog/categories` | `CreateCategoryRequestDto` `{ name, slug, parentSlug?, sortOrder? }` | `catalog:write` | `CategoryView` (201) |
| 2 | `PATCH /catalog/categories/:slug/parent` | `ReparentCategoryRequestDto` `{ newParentSlug?: string \| null }` | `catalog:write` | `CategoryReparentView` (200) |
| 3 | `GET /catalog/categories` | `?root=true\|false` | public | `CategoryView[]` (200) |
| 4 | `GET /catalog/categories/:slug/tree` | — | public | `CategoryTreeNodeView` (200) |
| 5 | `GET /catalog/categories/:slug/products` | `?includeDescendants`, `?page`, `?pageSize` | public | `IPage<ProductWithVariantsView>` (200) |
| 6 | `POST /catalog/products/:productId/categories` | `AttachProductCategoriesRequestDto` `{ categorySlugs: string[] }` | `catalog:write` | `ProductCategoriesView` (200) |
| 7 | `DELETE /catalog/products/:productId/categories/:categorySlug` | — | `catalog:write` | `ProductCategoriesView` (200) |

### Media routes (`media.controller.ts`)

| # | Method & path | Body / query | Auth | Response (status) |
|---|---|---|---|---|
| 8 | `POST /catalog/media` | `AttachMediaRequestDto` `{ ownerType, ownerId, uri, type, altText? }` | `catalog:write` | `MediaAssetView` (201) |
| 9 | `PATCH /catalog/media/reorder` | `ReorderMediaRequestDto` `{ ownerType, ownerId, mediaIdsInOrder: number[] }` | `catalog:write` | `MediaAssetView[]` (200) |
| 10 | `DELETE /catalog/media/:id` | — | `catalog:write` | `MediaAssetView` (200) |
| 11 | `GET /catalog/products/:productId/media` | — | public | `MediaAssetView[]` (200) |
| 12 | `GET /catalog/variants/:variantId/media` | — | public | `MediaAssetView[]` (200) |

## Decisions worth the ink

### Public read, staff write — and no new permission code

Read routes are `@Public()`: a storefront must render the navigation tree, a
category's products, and a product's media gallery **without a login**. Write
routes are gated with **`catalog:write`** — the *same* permission code that
already gates product authoring. We deliberately minted **no new permission** for
category/media authoring ([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)):
category and media are catalog content, and the operator who can write products
is the operator who can organize and illustrate them. Because customer tokens
carry **no `permissions` claim**, a `catalog:write` route is staff-only by
construction — an unauthenticated caller gets `401`, a logged-in customer gets
`403`.

### One RPC, two routes: attach and detach reclassify

There is a single membership RPC — `catalog.product.reclassify` — that takes an
attach list **and** a detach list, either of which may be empty. The gateway
exposes it as **two REST-shaped routes** so the HTTP surface reads naturally:

- `POST …/products/:id/categories { categorySlugs: [...] }` folds onto
  `reclassify({ attachCategorySlugs: categorySlugs, detachCategorySlugs: [] })`.
- `DELETE …/products/:id/categories/:slug` folds onto
  `reclassify({ attachCategorySlugs: [], detachCategorySlugs: [slug] })`.

Both routes return the **full current membership** (`ProductCategoriesView` =
the product header + every category it now belongs to, re-read after the write —
not a diff). Because they *update an existing relationship* rather than *create a
new resource*, both return **`200`, not `201`** — the same call as
publish/archive, which also mutate state in place. (`POST` for attach is the
REST-conventional verb for "add to a collection"; the `@HttpCode(200)` override
keeps the status honest about what happened.) Both are idempotent at the
microservice: re-attaching an existing membership or detaching a non-membership
is a silent success, and detaching from an *archived* category is allowed (a
historic membership stays removable) while attaching to one is a `409`.

### The reorder permutation contract

`PATCH /catalog/media/reorder` re-sequences an owner's media strip in one shot:
`mediaIdsInOrder` is the desired order, and each asset's new `sortOrder` becomes
its array index. The contract is **all-or-nothing** — the id list must be an
*exact permutation* of the owner's active media (same ids, no duplicates, no
omissions, no foreign or archived ids). A mismatch is rejected `409`
(`MEDIA_REORDER_SET_MISMATCH`) and **nothing is written**. The gateway's edge
DTO only checks the array is non-empty and every entry is a positive integer; the
permutation check needs the live active set, so it stays in the microservice.

The route lives at the **static** segment `media/reorder` (not a `:id` PATCH), so
it cannot collide with `DELETE media/:id` — Nest matches the literal segment
unambiguously. The same shape-based disambiguation lets the new
`…/:productId/media` and `…/:productId/categories` routes coexist with the
existing single-segment `GET /catalog/products/:slug` (an extra static segment
distinguishes them), and `catalog/categories` coexist with
`catalog/tax-categories` (distinct statics).

### `?includeDescendants` — the path-prefix expansion

`GET /catalog/categories/:slug/products` lists the active products attached to a
category. `?includeDescendants=true` widens the read from the single named
category to the category **plus its whole active subtree**. This is cheap because
of the materialized `path`: the use case resolves the subtree with one
`path LIKE '/menswear%'` read and unions the resulting category ids into the
membership filter (see
[`01-category-hierarchy-and-materialized-path.md`](01-category-hierarchy-and-materialized-path.md)
for the path design and
[`02-product-categories-join.md`](02-product-categories-join.md) for the
membership join). Omitted, the scope is the named category only.

### Boolean query parsing and `null`-vs-absent

Two read routes carry boolean query flags — `?root` (list) and
`?includeDescendants` (products). A query param always arrives as a **string**
(`?root=true` → `'true'`), so a bare `@IsBoolean()` would reject it and a bare
pass-through would treat `?root=false` as truthy. A shared `parseBooleanQuery`
`@Transform` (in `presentation/dto/validation.constants.ts`) normalizes the
recognized tokens (`'true'`/`'1'` → `true`, `'false'`/`'0'` → `false`), collapses
an absent/empty value to `undefined` (the "off" default the use case applies),
and leaves an unrecognized token untouched so `@IsBoolean()` rejects it with a
clean `400`.

The reparent body is the mirror case: `newParentSlug` is **optional and
nullable** — an absent *or* `null` value demotes the category to a root
(`path = /<slug>`), while a non-null value reparents under that slug.
`@IsOptional()` treats both `undefined` and `null` as "skip validation", so the
kebab-case `@Matches` runs only on a supplied non-null slug — exactly the
absent/null-demotes-to-root contract. (The cycle guard — you cannot move a
category under itself or a descendant, `409 CATEGORY_CYCLE` — is enforced in the
domain.)

### The publish `warnings[]` is already visible over HTTP

The publish soft-warning (a product published with no active media still
succeeds, but the response's `warnings[]` carries
`CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA` — see
[`04-publish-precondition-media-soft-warning.md`](04-publish-precondition-media-soft-warning.md))
needed **zero gateway work**. `POST /api/catalog/products/:id/publish` already
returns `ProductView` as a thin pass-through, and `warnings?` is an optional
field on `ProductView`, so it flows to HTTP automatically. This document's only
relationship to it: once these media routes exist, an operator can *act* on the
warning — attach an image, re-publish, and watch `warnings` disappear.

## Validation at the edge

The request DTOs are class-validator shapes — the gateway's fail-fast guard so a
malformed request `400`s before an RPC is dispatched. They reuse the shared
`SLUG_PATTERN` / `SLUG_REGEX` (kebab-case, the stricter path-segment form the
catalog domain enforces) from `validation.constants.ts`, so the documented shape
and the enforced shape never drift. The catalog domain still has the final say on
every invariant — the edge guard is an optimization, not the source of truth.

## Verifying

A manual smoke walk (gateway + catalog microservice booted against the seeded DB)
exercises all twelve routes plus the gates:

1. `POST /catalog/categories` → create `menswear` (root), then `shirts`
   (`parentSlug: menswear`) → `path` derives to `/menswear` and
   `/menswear/shirts`.
2. `GET /catalog/categories` → both; `?root=true` → only `menswear`.
3. `PATCH /catalog/categories/shirts/parent { newParentSlug: null }` → demoted to
   `/shirts` (`rewrittenDescendantCount: 0`); back under `menswear` restores it.
4. `GET /catalog/categories/menswear/tree` → `menswear` with a nested `shirts`
   child.
5. `POST /catalog/products/1/categories { categorySlugs: ["menswear"] }` →
   product 1 now lists `menswear`.
6. `GET /catalog/categories/menswear/products` → the `IPage` envelope with
   product 1 + its variants.
7. `POST /catalog/media` twice → images at `sortOrder` 0 then 1;
   `GET /catalog/products/1/media` returns both, sorted.
8. `PATCH /catalog/media/reorder` swaps them; `DELETE /catalog/media/:id` archives
   one (status flip — gone from the active list, row survives).
9. `GET /catalog/variants/1/media` → `[]` (no media attached, not a 404).
10. `DELETE /catalog/products/1/categories/menswear` → membership back to `[]`.

Gates: an unauthenticated `POST /catalog/categories` → `401`; a seeded-customer
token → `403` (categories and media both). Typed pass-through: a duplicate slug →
`409`, an unknown parent slug → `404`, a malformed slug → `400`, a mismatched
reorder set → `409`.

## See also

- [ADR-029](../../adr/029-category-materialized-path-and-polymorphic-media.md) —
  the materialized-path `Category` and polymorphic `MediaAsset` design this API
  fronts.
- [ADR-009](../../adr/009-port-adapter-at-the-gateway.md) — the gateway
  port/adapter split.
- [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) — the
  permission model behind the public-read/staff-write split.
- Sibling docs: [01 — category hierarchy](01-category-hierarchy-and-materialized-path.md),
  [02 — product–categories join](02-product-categories-join.md),
  [03 — media polymorphism](03-media-asset-polymorphism.md),
  [04 — publish media soft warning](04-publish-precondition-media-soft-warning.md).
