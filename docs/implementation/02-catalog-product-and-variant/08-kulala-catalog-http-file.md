# 08 — Kulala `http/catalog.http` file

This document records the runnable HTTP client file that drives every catalog
gateway endpoint end-to-end. The gateway exposes the catalog operations over
HTTP at `/api/catalog` (see
[07 — API-gateway catalog module](./07-api-gateway-catalog-module.md)); this
change adds `http/catalog.http` so a developer can exercise the whole surface
locally — login, the four protected write commands, and the three public read
queries — straight from an editor with the
[Kulala](https://kulala.mwco.app/) / REST Client `.http` runner.

It follows the conventions of the sibling files (`http/auth.http`,
`http/iam.http`, `http/order.http`, `http/product.http`) and the shared
environment file `http/http-client.env.json`.

## 1. What the file covers

`http/catalog.http` contains one `# @name`-labelled block per request. Reading
top to bottom it tells the full lifecycle story of a product:

| Block | Method + path | Auth | What it proves |
|---|---|---|---|
| `login` | `POST /api/auth/staff/login` | — | Seeds `@accessToken` from the admin login. |
| `registerProduct` | `POST /api/catalog/products` | Bearer (`catalog:write`) | Creates a `draft` product; captures `@productId` / `@productSlug`. |
| `addVariantBlack` | `POST /api/catalog/products/:productId/variants` | Bearer (`catalog:write`) | Appends a variant; captures `@variantId`. |
| `addVariantGraphite` | `POST /api/catalog/products/:productId/variants` | Bearer (`catalog:write`) | A second variant on the same product. |
| `publishProduct` | `POST /api/catalog/products/:productId/publish` | Bearer (`catalog:publish`) | `draft → active` (domain requires ≥ 1 variant). |
| `listProducts` | `GET /api/catalog/products?status=active&page=1&pageSize=20` | public | Browses the active catalogue; the published product appears. |
| `getProductBySlug` | `GET /api/catalog/products/:slug` | public | Resolves the product by slug with its active variants. |
| `getVariant` | `GET /api/catalog/variants/:variantId` | public | Resolves the variant plus its parent product header. |
| `archiveProduct` | `POST /api/catalog/products/:productId/archive` | Bearer (`catalog:write`) | `active → archived` (terminal soft-delete). |
| `listProductsAfterArchive` | `GET /api/catalog/products?status=active&search=aeron` | public | The archived product is gone from browse. |

The ten blocks cover all **seven** distinct endpoints. Add-variant and the
browse list each appear twice on purpose: a second variant gives publish more
than the bare minimum and makes the read views return a multi-entry collection,
and the second browse — after the archive — demonstrates that an archived
product drops out of the active listing while still resolving by slug/id.

## 2. The prereq login-and-capture flow

The header `# Prereqs:` block spells out the local bring-up:

```bash
docker compose up -d      # MySQL + RabbitMQ + Redis
yarn migration:run        # apply the schema
yarn test:seed            # seed the admin + RBAC rows
yarn start:dev            # gateway + microservices
```

Then the **`login` block must run first**. It posts the seeded admin
credentials and the file captures the bearer token into a file variable
immediately after the request:

```
###
@accessToken = {{login.response.body.$.accessToken}}
```

The JSON path `{{login.response.body.$.accessToken}}` matches the login response
shape `TokenResponseDto { accessToken, refreshToken, expiresIn }` — the same
field `http/auth.http` and `http/iam.http` read. Every protected block below
sends `Authorization: Bearer {{accessToken}}`. The seeded admin
(`admin@example.com` / `admin1234`) holds every permission code, so the one
token satisfies both `catalog:write` and `catalog:publish` with no role juggling.

## 3. How to run it locally

- **Environment file.** The top of the file declares `@baseUrl = {{ENV_BASE_URL}}`,
  and `ENV_BASE_URL` resolves from `http/http-client.env.json`
  (`dev.ENV_BASE_URL = http://localhost:3000/api`). No new environment value was
  needed — the existing `dev` profile suffices, so the env file was left
  unchanged.
- **Base URL.** All routes live under the gateway's global `api` prefix
  (`app.setGlobalPrefix(...)` in `main.ts`), which is why `@baseUrl` already
  carries the `/api` suffix and each block appends `/catalog/...` or
  `/auth/...`.
- **Seeded admin.** The write blocks depend on the seeded `admin@example.com`
  user existing with the full permission set; that is what `yarn test:seed`
  provides.
- **Re-runs.** The product slug (`aeron-chair`) and the variant SKUs are fixed,
  and the catalog enforces slug/SKU uniqueness, so a second straight-through run
  against the same database is rejected on the create blocks. Re-seed between
  runs (`yarn test:infra:reload`) for a clean slate.

## 4. Which requests need a bearer token, which are public

This mirrors the gateway's read/write split
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md),
[ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)):

- **Protected (Bearer).** `registerProduct`, `addVariantBlack`,
  `addVariantGraphite`, `archiveProduct` are gated by `catalog:write`;
  `publishProduct` by the higher-trust `catalog:publish`. Each carries an
  `Authorization: Bearer {{accessToken}}` header.
- **Public (no header).** `listProducts`, `getProductBySlug`, `getVariant` are
  `@Public()` routes. The blocks deliberately send **no** `Authorization`
  header — running them proves the read path serves an unauthenticated shopper.

A customer token would not help on the write blocks: customer access tokens
carry no `permissions` claim, so any `@RequiresPermission(...)` route is
staff-only by construction. The file uses the staff admin login throughout.

## 5. How the chaining threads `productId` / `variantId`

The write blocks chain through file variables so the file runs end-to-end
without manual edits — the same pattern `http/iam.http` uses to thread a
created role id into a later `PATCH`:

- `registerProduct` returns `ProductView`; the file captures
  `@productId = {{registerProduct.response.body.$.id}}` and
  `@productSlug = {{registerProduct.response.body.$.slug}}`.
- `addVariantBlack` returns `ProductVariantView`; the file captures
  `@variantId = {{addVariantBlack.response.body.$.id}}`.
- `addVariantGraphite`, `publishProduct`, and `archiveProduct` target the owning
  product via `{{productId}}` in the path.
- `getProductBySlug` resolves `{{productSlug}}`; `getVariant` resolves
  `{{variantId}}`.

Because the captures land on the just-created rows, the order encodes the
domain's own rules: a product must carry ≥ 1 variant before `publish` accepts it
(`draft → active`), and `archive` only applies to an `active` product
(`active → archived`). Running the blocks in sequence walks that lifecycle and
ends by showing the archived product is hidden from browse yet still resolvable
by slug and by variant id.

## 6. Verification

With a seeded, running stack, run the blocks top to bottom:

```
login → registerProduct → addVariantBlack → addVariantGraphite → publishProduct
      → listProducts → getProductBySlug → getVariant → archiveProduct
      → listProductsAfterArchive
```

Expected results: `login` → `200` with `accessToken`; `registerProduct` → `201`
`status: 'draft'`; both add-variant blocks → `201` `status: 'active'`;
`publishProduct` → `200` `status: 'active'` with `publishedAt`; `listProducts`
→ `200` envelope listing the product with its two active variants;
`getProductBySlug` → `200` the product with its variants; `getVariant` → `200`
the variant plus its parent product header; `archiveProduct` → `200`
`status: 'archived'` with `archivedAt`; `listProductsAfterArchive` → `200` an
envelope that no longer contains the product.
