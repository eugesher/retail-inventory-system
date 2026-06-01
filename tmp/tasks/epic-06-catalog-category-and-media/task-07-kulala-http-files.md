---
epic: epic-06
task_number: 7
title: Author http/catalog-categories.http and http/catalog-media.http
depends_on: [epic-02, task-01, task-02, task-03, task-04, task-05, task-06]
doc_deliverable_primary: docs/implementation/06-catalog-category-and-media/06-kulala-files.md
---

# Task 07 — Kulala HTTP files for category + media

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs only as needed:
  - [ADR-010](../../../docs/adr/010-jwt-rbac-at-the-gateway.md) — the write blocks need a staff bearer; mirror the login-then-substitute pattern in the existing `http/auth.http` + `http/iam.http`.

## Goal

Author two Kulala `.http` files documenting the new endpoints end-to-end, matching the conventions in the existing `http/` files (`auth.http`, `iam.http`, `order.http`, `product.http`): a header comment naming the controller source files, the `@baseUrl = {{ENV_BASE_URL}}` line, `###` block separators, `# @name` tags, and `{{login.response.body.$...}}` token substitution for authenticated calls. These are run with the Kulala client against a locally-running stack.

## Entry state assumed

`epic-02` merged; tasks 01–06 carryover present:

- All 11 gateway endpoints from task-06 are live.
- `http/http-client.env.json` defines `dev.ENV_BASE_URL = http://localhost:3000/api` (already present).
- A staff login flow exists (`POST /api/auth/staff/login`) returning an access token; the seeded admin (`admin@example.com` / `admin1234`) holds `catalog:write` (the `catalog-manager` seed lands in task-08 — until then the admin bearer drives the write blocks).

## Scope

**In:**

- `http/catalog-categories.http` — covers category CRUD + reparent + flat list + tree + product-category attach/detach + browse-by-category.
- `http/catalog-media.http` — covers media create + reorder + archive(detach) + browse by product and by variant.
- Doc deliverable `06-kulala-files.md`.

**Out:**

- No env-file change (`ENV_BASE_URL` already exists). If a second env var is genuinely needed, add it to `http/http-client.env.json` — but prefer token substitution over new vars.
- Seed data — task-08. Until task-08, the files assume the admin can create the fixtures the GET blocks then read (each file is self-bootstrapping: create-then-read).

## File shapes

Each file opens with a header comment block naming the source controllers (`apps/api-gateway/src/modules/catalog/presentation/{category,media}.controller.ts`) and the global `api` prefix note, then `@baseUrl = {{ENV_BASE_URL}}`, then a `staffLogin` block whose response feeds the bearer:

```
# Catalog category endpoints
# (apps/api-gateway/src/modules/catalog/presentation/category.controller.ts)
#
# Send blocks in order: staffLogin first establishes the access token every
# write block substitutes via {{staffLogin.response.body.accessToken}}.
# GET blocks are @Public() and need no bearer.

@baseUrl = {{ENV_BASE_URL}}

###

# @name staffLogin
# POST /api/auth/staff/login — seeded admin holds catalog:write.
POST {{baseUrl}}/auth/staff/login
Content-Type: application/json

{ "email": "admin@example.com", "password": "admin1234" }

###

# @name createRoot
# POST /api/catalog/categories — root category (no parentSlug).
POST {{baseUrl}}/catalog/categories
Content-Type: application/json
Authorization: Bearer {{staffLogin.response.body.accessToken}}

{ "name": "Electronics", "slug": "electronics" }

###

# @name createChild
# POST /api/catalog/categories — child under electronics.
POST {{baseUrl}}/catalog/categories
Content-Type: application/json
Authorization: Bearer {{staffLogin.response.body.accessToken}}

{ "name": "Phones", "slug": "phones", "parentSlug": "electronics" }

### ... (reparent, list, tree, reclassify, detach, browse blocks follow)
```

Verify the exact access-token field name against `http/auth.http` (`staffLogin.response.body.$....`) and match it — do not invent a field name.

### `http/catalog-categories.http` blocks (in order)

1. `staffLogin`.
2. `createRoot` (`electronics`), `createChild` (`phones` under `electronics`), `createSecondChild` (`apparel` root), `createGrandchild`.
3. `reparentGrandchild` — `PATCH /catalog/categories/:slug/parent` with `{ "newParentSlug": "apparel" }`; comment notes the response carries `descendantsRewritten`.
4. `reparentToRoot` — `PATCH …/parent` with empty/omitted `newParentSlug` (demote to root); comment explains root demotion.
5. `listAll` (`GET /catalog/categories`), `listRootsOnly` (`?root=true`) — `@Public()`, no bearer.
6. `getTree` (`GET /catalog/categories/electronics/tree`) — `@Public()`.
7. `reclassifyProduct` (`POST /catalog/products/1/categories` `{ "categorySlugs": ["electronics","phones"] }`), `detachProductCategory` (`DELETE /catalog/products/1/categories/phones`).
8. `browseProducts` (`GET /catalog/categories/electronics/products?includeDescendants=true&page=1`) — `@Public()`.
9. `cycleReparentRejected` — `PATCH …/electronics/parent` with `{ "newParentSlug": "phones" }` (a descendant) → comment notes expected `409`.

### `http/catalog-media.http` blocks (in order)

1. `staffLogin`.
2. `attachImage`, `attachVideo`, `attachDocument` — `POST /catalog/media` with `ownerType: "product"`, `ownerId: 1`, distinct `uri`/`type`; comment notes `sortOrder` auto-assigns 0,1,2.
3. `reorderMedia` — `PATCH /catalog/media/reorder` `{ "ownerType": "product", "ownerId": 1, "mediaIdsInOrder": [<id3>, <id1>, <id2>] }`; comment notes ids come from the attach responses.
4. `browseProductMedia` (`GET /catalog/products/1/media`), `browseVariantMedia` (`GET /catalog/variants/1/media`) — `@Public()`.
5. `detachMedia` (`DELETE /catalog/media/:id`) — comment notes soft-delete (status flip), and that a subsequent browse returns the remaining two.

## Files to add

- `http/catalog-categories.http`.
- `http/catalog-media.http`.
- `docs/implementation/06-catalog-category-and-media/06-kulala-files.md`.

## Files to modify

- `http/http-client.env.json` — only if a new var is genuinely required (prefer not).

## Files to delete

None.

## Tests

No automated tests — these are manual request files. Validation is by running each block against a locally-running stack with seeded/created data (the file create-bootstraps its own fixtures). The epic's Exit Criteria require every block to execute end-to-end (verified under task-08 once seeds land).

## Doc deliverable — `06-kulala-files.md`

Target ~70 lines. Sections:

1. **What the two files cover.** Category CRUD/reparent/list/tree/reclassify/browse; media create/reorder/detach/browse.
2. **Run order + token substitution.** `staffLogin` first; `{{staffLogin.response.body.<token-field>}}` on write blocks; GET blocks are `@Public()`.
3. **Self-bootstrapping vs seeded.** The files create their own fixtures so they run against an empty DB; task-08's seed makes the GET blocks return data without the create steps.
4. **The cycle + permission expectations.** Which blocks intentionally expect `409` / `403` and why.

## Carryover produced (consumed by task-08)

- Both `.http` files exist; task-08 verifies every block executes against the seeded stack and flips any disabled permission blocks.
- `06-kulala-files.md` exists.

## Exit criteria

- [ ] Both `.http` files follow the existing convention (header comment, `@baseUrl`, `###`, `# @name`, token substitution).
- [ ] `yarn lint` passes (`.http` files are not linted, but no source changed that would break it).
- [ ] Manually: with the stack running, each block executes (writes with the admin bearer, reads public); the cycle block returns `409`.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] `06-kulala-files.md` exists with the sections above.
