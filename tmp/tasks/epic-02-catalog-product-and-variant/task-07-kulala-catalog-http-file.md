---
epic: epic-02
task_number: 7
title: Author http/catalog.http (Kulala) covering every catalog endpoint
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06]
doc_deliverable: docs/implementation/epic-02-catalog-product-and-variant/07-kulala-catalog-http-file.md
---

# Task 07 — Author `http/catalog.http`

## Goal

Add the first-class HTTP documentation file for the catalog surface. Mirror the conventions used by `http/order.http`, `http/product.http`, and the two `epic-01` files (`http/auth.http`, `http/iam.http`). The file is consumed by the Kulala Neovim plugin (the user works in Neovim) and doubles as living documentation for what each catalog endpoint expects.

The file must chain requests using Kulala's `# @name X` / `{{X.response.body.$.path}}` substitution so the operator can `staffLogin → registerProduct → addVariant → publishProduct → listProducts → archiveProduct` in order without copy-pasting tokens or ids.

## Entry state assumed

Task-06 carryover present:

- All seven catalog HTTP endpoints exist and respond correctly under a fresh seed:
  - `POST /api/catalog/products`, `POST /api/catalog/products/:productId/variants`, `POST /api/catalog/products/:productId/publish`, `POST /api/catalog/products/:productId/archive`, `GET /api/catalog/products`, `GET /api/catalog/products/:slug`, `GET /api/catalog/variants/:variantId`.
- `http/http-client.env.json` defines `ENV_BASE_URL` (currently `http://localhost:3000/api` based on existing files).
- `http/auth.http` exists from `epic-01`'s task-08 and demonstrates the canonical staffLogin block — `catalog.http` mirrors its `# @name staffLogin` block for the prereq.

## Scope

**In:**

- One new file: `http/catalog.http`.
- Mirror the `http/order.http` shape exactly (purpose block at top, `@baseUrl = {{ENV_BASE_URL}}`, `###` separators between blocks, `# @name X` on each request, and a leading comment that cites the gateway controller file with line-anchored hint where relevant).
- A `# Prereqs:` block at the top describing the seeded admin login flow and noting where each capture lands (`staffLogin.response.body.$.accessToken`, `registerProduct.response.body.$.id`, `addVariant.response.body.$.id`).
- Doc deliverable `07-kulala-catalog-http-file.md`.

**Out:**

- Any change to `http/http-client.env.json` — match existing convention (`ENV_BASE_URL` is sufficient; everything else is hardcoded in the .http file).
- Tests around .http files (Kulala is editor tooling, not CI).
- Customer-facing browse via a non-staff bearer — the public endpoints don't require a bearer, so the operator simply omits the `Authorization` header on those blocks.

## `http/catalog.http` — structure

Top comment block describing the file. Cite the gateway controller path `apps/api-gateway/src/modules/catalog/presentation/catalog.controller.ts` and list the seven endpoints with one-line descriptions.

`@baseUrl = {{ENV_BASE_URL}}`.

`# Prereqs:` block:

> Run `# @name staffLogin` first; later blocks reference `{{staffLogin.response.body.$.accessToken}}`.
>
> Seed assumption: the seeded `admin@example.com` user has `catalog:write` + `catalog:publish` + `catalog:read`. Task-09 of `epic-02` also seeds a `catalog-manager` user that has the same three permissions but lacks `iam:role-edit` — switching to that user lets you observe the full RBAC matrix at the catalog scope.

Then one block per endpoint, in this order (so they can be sent sequentially as a flow):

1. **`# @name staffLogin` — `POST {{baseUrl}}/auth/staff/login`** with body `{ "email": "admin@example.com", "password": "admin1234" }`. Comment: "Canonical staff login (from `epic-01`'s task-08). Returns access + refresh tokens. The access JWT carries `permissions: string[]`."
2. **`# @name registerProduct` — `POST {{baseUrl}}/catalog/products`** with header `Authorization: Bearer {{staffLogin.response.body.$.accessToken}}` and body `{ "name": "Classic Cotton Tee", "slug": "classic-cotton-tee", "description": "Soft jersey, regular fit." }`. Comment: "Gated `catalog:write`. Creates a draft Product. The response body's `id` is captured for the next block."
3. **`# @name addVariantSmallRed` — `POST {{baseUrl}}/catalog/products/{{registerProduct.response.body.$.id}}/variants`** with body `{ "sku": "TEE-RED-S", "gtin": "04902430735063", "optionValues": { "color": "red", "size": "S" }, "weightG": 180, "dimensionsMm": { "l": 280, "w": 220, "h": 5 } }`. Comment: "Gated `catalog:write`. Emits `catalog.variant.created` on the bus. Duplicate SKUs return 409."
4. **`# @name addVariantMediumBlue` — `POST {{baseUrl}}/catalog/products/{{registerProduct.response.body.$.id}}/variants`** with body `{ "sku": "TEE-BLUE-M", "optionValues": { "color": "blue", "size": "M" } }`. Comment: "Same gate, different option values. `gtin` and weight/dimensions are optional."
5. **`# @name publishProduct` — `POST {{baseUrl}}/catalog/products/{{registerProduct.response.body.$.id}}/publish`** with header `Authorization: Bearer {{staffLogin.response.body.$.accessToken}}`. Comment: "Gated `catalog:publish`. Requires ≥1 variant (added above). Emits `catalog.product.published`. Returns the active aggregate with `publishedAt`."
6. **`# @name listProducts` — `GET {{baseUrl}}/catalog/products?page=1&pageSize=20`** with no auth header. Comment: "`@Public()` — buyer-facing browse. Pagination defaults: page=1, pageSize=20, max pageSize=100. Use `?search=tee` for a name match."
7. **`# @name getProductBySlug` — `GET {{baseUrl}}/catalog/products/classic-cotton-tee`** with no auth header. Comment: "`@Public()` — fetches the full Product including active variants. 404 if archived."
8. **`# @name getVariant` — `GET {{baseUrl}}/catalog/variants/{{addVariantSmallRed.response.body.$.id}}`** with no auth header. Comment: "`@Public()` — fetches a single variant with parent-product header denormalised. 404 if the parent is archived."
9. **`# @name archiveProduct` — `POST {{baseUrl}}/catalog/products/{{registerProduct.response.body.$.id}}/archive`** with header `Authorization: Bearer {{staffLogin.response.body.$.accessToken}}`. Comment: "Gated `catalog:write` (not `catalog:publish` — see doc 06 for rationale). Emits `catalog.product.archived`. Re-running `listProducts` should now return zero rows for this Product."

Optional permission-failure blocks (only if the seed extension in task-09 makes them runnable today):

10. **`# @name nonCatalogStaffLogin` — `POST {{baseUrl}}/auth/staff/login`** with body for a seeded `warehouse-staff` user (e.g. `warehouse@example.com`). Captures a token without `catalog:write`.
11. **`# @name registerProductForbidden` — `POST {{baseUrl}}/catalog/products`** with that token and a different slug. Expect 403. Comment: "Confirms the `catalog:write` gate."

If the relevant seed user doesn't exist yet (task-09 may not have shipped at the time the operator opens the file), prefix blocks 10–11 with a `### DISABLED — requires task-09 seed` comment.

## Files to add

- `http/catalog.http` (structure above).
- `docs/implementation/epic-02-catalog-product-and-variant/07-kulala-catalog-http-file.md`.

## Files to modify

None.

## Files to delete

None.

## Verification

Manual against a freshly-seeded gateway (`docker compose up -d mysql redis rabbitmq && yarn migration:run && yarn seed && yarn start:dev:api-gateway && yarn start:dev:catalog-microservice`):

- Open `http/catalog.http` in Neovim with Kulala. Send `staffLogin`; verify 200 + tokens. Send `registerProduct`; verify 201 + `status='draft'`. Send `addVariantSmallRed` then `addVariantMediumBlue`; verify 201 each. Send `publishProduct`; verify 200 + `status='active'`. Send `listProducts`; verify the new Product appears with both variants. Send `getProductBySlug` and `getVariant`; verify 200 each. Send `archiveProduct`; verify 200 + `status='archived'`. Send `listProducts` again; the archived Product no longer appears.

## Doc deliverable

Write `docs/implementation/epic-02-catalog-product-and-variant/07-kulala-catalog-http-file.md`. Target ~80 lines. Sections:

1. **What `http/catalog.http` covers.** One paragraph mapping each block to its endpoint, with a note that the file's request order doubles as the "happy-path admin demo" flow.
2. **Conventions inherited from `http/order.http`.** `@baseUrl`, `# @name`, `{{X.response.body.$.path}}` chaining. Why each block has a leading `#` comment naming the route + gate.
3. **The chaining strategy.** Why the file is one long sequential flow (not 9 isolated blocks): catalog operations are naturally chained — you cannot Add Variant without a registered Product, cannot Publish without a Variant, etc. Kulala's variable substitution lets the file represent that ordering without forcing the operator to copy-paste ids.
4. **Permission-failure blocks.** Disabled-by-default until task-09's seed extension ships; flipping them on is a one-line change once the `warehouse-staff` (or equivalent non-catalog) seed user exists.
5. **What's missing.** A separate buyer-customer flow (would require a seeded Customer with a JWT — exists from `epic-01`'s task-05 if it shipped). For now, the public GETs are exercised without `Authorization` (since they're `@Public()`).

## Carryover produced

- One new `.http` file; one new doc.
- The "disabled until task-09" markers are present so task-09's seed extension can enable them mechanically.

## Exit criteria

- [ ] `http/catalog.http` exists and mirrors the conventions of `http/order.http`.
- [ ] Every endpoint listed in task-06's API table appears in the file.
- [ ] Operator can execute every enabled block in order against a freshly-seeded gateway — each request succeeds with the documented status code.
- [ ] Doc `07-kulala-catalog-http-file.md` exists.
- [ ] No file outside `tmp/` references `tmp/`.
