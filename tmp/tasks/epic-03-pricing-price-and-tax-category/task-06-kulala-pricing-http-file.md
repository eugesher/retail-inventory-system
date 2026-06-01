---
epic: epic-03
task_number: 6
title: Author http/pricing.http (Kulala) covering Set Price, Schedule Price, list/select Price, TaxCategory CRUD, attach TaxCategory to Variant
depends_on: [task-05]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md
---

# Task 06 — Author `http/pricing.http`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Add a Kulala HTTP file that exercises every pricing endpoint end-to-end. The file is a living reproduction of the pricing surface — a developer should be able to clone the repo, run `docker compose up -d && yarn migration:run && yarn start:dev && yarn test:seed`, then execute the file top-to-bottom and observe the full Set / Schedule / Select / TaxCategory / Attach flow. The file also serves as the Kulala half of doc `06-pricing-api-and-kulala.md` — task-05 wrote the api description; this task appends the Kulala flow section pointing at the new file.

The other purpose of this file is to document the order-of-operations gotchas: which call must run before which, which seed-state is assumed, which response field feeds the next request's path or body. Kulala files in this repo include `# @name` markers and prose `#` comments — the new file follows that convention (verified by reading `http/product.http` and `http/order.http`).

## Entry state assumed

Task-05 complete. Specifically:

- The six new HTTP endpoints from §"Endpoint table" in task-05 are reachable on the api-gateway.
- `http/http-client.env.json` carries the `ENV_BASE_URL` variable (used by the existing `product.http` + `order.http` files as `@baseUrl = {{ENV_BASE_URL}}`).
- Epic-02's seed (the two seeded products with their variants) is the assumed starting state for the file's prereqs. The exact variant ids are whatever epic-02 task-09 seeded — likely `1` and `2` for the two variants of product `1`. **Action**: read `scripts/test-db-seed.ts` (post-epic-02) to confirm the ids; pin them in the file's `# Prereqs:` header rather than guess.
- An admin user exists (epic-01 task-09 seeded one). The Kulala convention in this repo is to expect the operator to paste a bearer token into the file's `@adminToken` variable before running write requests. Match this convention.
- Task-07 has NOT yet seeded prices, so the file's first few requests are write requests that bootstrap the state, then later requests assume that earlier writes succeeded.

## Scope

**In:**

- New file: `http/pricing.http`.
- Variables at the top: `@baseUrl`, `@adminToken`, plus convenience id variables (`@variantA = 1`, `@variantB = 2` — pin to the actual epic-02 seed ids).
- Request blocks, each preceded by a `#` prose explanation of intent + a `# @name` marker:
  1. `listTaxCategoriesEmpty` — `GET /api/catalog/tax-categories` — before any TaxCategory is created. Expected response: `[]` (or the three seeded categories if task-07's seed has already run; the file's `# Prereqs:` clarifies).
  2. `createTaxCategoryStandard` — `POST /api/catalog/tax-categories` with `{ code: 'STANDARD', name: 'Standard rate', description: 'Default classification' }`. Asserts the auth + the code shape.
  3. `createTaxCategoryReduced` and `createTaxCategoryExempt` — same shape, different codes.
  4. `createTaxCategoryDuplicate` — POST `STANDARD` again. Expected: `409 Conflict` (or `400 Bad Request` depending on how the unique constraint surfaces; document the actual code in the file's comment).
  5. `createTaxCategoryBadCode` — POST `{ code: 'has-dash' }`. Expected: `400 Bad Request` (the regex pipe rejects).
  6. `listTaxCategoriesPopulated` — `GET /api/catalog/tax-categories`. Expected: the three rows.
  7. `attachTaxCategoryToVariantA` — `PATCH /api/catalog/variants/{{variantA}}/tax-category` with `{ taxCategoryCode: 'STANDARD' }`. Returns the updated variant DTO; `taxCategoryId` is populated.
  8. `attachTaxCategoryUnknownCode` — `PATCH …/tax-category` with `{ taxCategoryCode: 'NONEXISTENT' }`. Expected: `404 Not Found`.
  9. `attachTaxCategoryUnknownVariant` — `PATCH /api/catalog/variants/99999/tax-category` with a valid code. Expected: `404 Not Found`.
  10. `getCurrentPriceBeforeAnySet` — `GET /api/catalog/variants/{{variantA}}/price?currency=USD`. Expected: `404 Not Found` (no Price exists yet).
  11. `publishProductBeforeAnyPrice` — `POST /api/catalog/products/1/publish`. Expected: `409 Conflict` with `PublishPreconditionFailedError` body listing `variantA` and `variantB` as missing prices. **This is the canonical demonstration of task-04's hard rule.** Add an emphatic comment.
  12. `setPriceForVariantA` — `POST /api/catalog/variants/{{variantA}}/prices` with `{ currency: 'USD', amountMinor: 1999 }`. Expected: 200 with a `PriceResponseDto`.
  13. `setPriceForVariantB` — same for `variantB`, `amountMinor: 2499`.
  14. `publishProductAfterBothPriced` — `POST /api/catalog/products/1/publish`. Expected: 200; product status is `active`.
  15. `getCurrentPriceVariantA` — `GET /api/catalog/variants/{{variantA}}/price?currency=USD`. Expected: 200 with the `1999` Price.
  16. `getCurrentPriceVariantA_unknownCurrency` — `GET …/price?currency=EUR`. Expected: `404 Not Found` (no EUR price exists).
  17. `listPricesInEffectVariantA` — `GET /api/catalog/variants/{{variantA}}/prices?currency=USD`. Expected: array of length 1.
  18. `schedulePriceForVariantA` — `POST /api/catalog/variants/{{variantA}}/prices` with `{ currency: 'USD', amountMinor: 2299, validFrom: <ISO timestamp = now + 1 hour>, priority: 10 }`. Expected: 200 (the controller dispatches to schedule because `validFrom > now`). The doc reminds the operator that Kulala/IntelliJ-HTTP allows dynamic values via `{{$timestamp}}` — use the equivalent expression the project's existing http files already use (e.g. `{{$datetime iso8601 1 h}}` — check `http/order.http` for the convention).
  19. `getCurrentPriceAfterSchedule` — `GET …/price?currency=USD`. Expected: still the `1999` Price (the scheduled `2299` is future-effective).
  20. `getFuturePriceWithAsOf` — `GET …/price?currency=USD&asOf={{$datetime iso8601 2 h}}`. Expected: the `2299` Price.
  21. `replacePriceWithNewNow` — `POST /api/catalog/variants/{{variantA}}/prices` with `{ currency: 'USD', amountMinor: 1899 }`. Expected: 200; the previously-open `1999` Price is now closed (its `validTo` matches the new Price's `validFrom`). The audit-trail invariant: query historic.
  22. `getHistoricPriceAsOf` — `GET …/price?currency=USD&asOf=<a timestamp between the 1999 set and now>`. Expected: the `1999` Price (proves history is preserved).
  23. `listPricesInEffectAfterReplace` — `GET …/prices?currency=USD`. Expected: one Price (the new `1899`). The "in effect" list only shows currently-open Prices.
  24. `setPriceUnauthorized` — `POST …/prices` with the `Authorization` header dropped. Expected: 401.
  25. `setPriceForbidden` — `POST …/prices` with a non-admin / non-catalog-manager bearer token. Expected: 403.
- Each block separated by a `###` Kulala block separator. Match the spacing convention in `http/product.http` / `http/order.http`.
- Header block at the top of the file:
  - `# Pricing endpoints (apps/api-gateway/src/modules/catalog/presentation/...)` with a brief description.
  - `# Prereqs:` listing required seed state (admin user, seeded products with variants A and B) and the env vars expected.
  - `# Tip:` a one-line reminder about how to refresh the admin token if it expires (point at `http/auth.http` if epic-01 task-08 added one).
- Append a "Kulala flow" section to `docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md` describing what `http/pricing.http` covers and in what order.

**Out:**

- The api endpoint description — already in doc 06 (api half, from task-05).
- The e2e test — task-07 (`test/pricing.e2e-spec.ts`) is a different artifact: programmatic, machine-asserted; the http file is human-driven and exploratory.
- Auth.http or iam.http file modifications — epic-01 task-08 owns those.

## File template

```http
# Pricing endpoints (apps/api-gateway/src/modules/catalog/presentation/...)
#
# Exercises Set Price, Schedule Price, Select Applicable Price, list Prices,
# TaxCategory CRUD, and Variant→TaxCategory attachment. Also demonstrates
# the publish-no-price hard-fail introduced in epic-03 task-04.
#
# Prereqs:
#   - docker compose up -d
#   - yarn migration:run
#   - yarn start:dev (or the per-app start:dev for api-gateway + catalog-microservice)
#   - yarn test:seed (epic-02's seed populates products with variants 1 and 2)
#   - paste a valid admin bearer token into @adminToken below; if you don't
#     have one to hand, run http/auth.http's loginAdmin request first.
#
# Tip: the dispatching between Set Price and Schedule Price is decided by
# whether body.validFrom is in the future. The same POST endpoint covers
# both; the audit-trail distinction (catalog.price.changed vs.
# catalog.price.scheduled) is preserved at the microservice layer.

@baseUrl = {{ENV_BASE_URL}}
@adminToken = paste-your-bearer-token-here
@variantA = 1
@variantB = 2
@productId = 1

###

# @name listTaxCategoriesEmpty
# GET /api/catalog/tax-categories
# Public. Returns the seeded set ([] if task-07 seed has not run; [STANDARD,
# REDUCED, EXEMPT] after).
GET {{baseUrl}}/api/catalog/tax-categories

###

# … remaining 24 blocks per the §"Scope" list, each with a @name marker, a
# one-paragraph prose explanation, the request, and a comment noting the
# expected status code …
```

## Adapting to the existing http convention

Before writing, run `cat http/product.http http/order.http` and copy:

- The exact `@baseUrl = {{ENV_BASE_URL}}` line.
- The exact `###` separator convention (some Kulala dialects use `###` with no trailing space; match what is already in the repo).
- The exact prose-comment style (a single `#` per line, blank `#` lines allowed; double-spaced before each `# @name`).
- If `http/order.http` uses any specific syntax for ISO-8601 timestamps generated at request time (e.g. Kulala's `{{$datetime iso8601 …}}` or IntelliJ's `{{$timestamp}}`), reuse it. If no convention exists, hardcode an ISO timestamp with a comment instructing the operator to update it before running.

## Files to add

- `http/pricing.http`.

## Files to modify

- `docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md` — append the "Kulala flow" section described under §"Doc deliverable" below.
- `http/http-client.env.json` — only if a new env variable is needed. Likely no change; `ENV_BASE_URL` already suffices.

## Files to delete

None.

## Doc deliverable

This task does NOT create a new doc; it **appends** the Kulala flow section to `06-pricing-api-and-kulala.md` (the file was created by task-05). The appended section, ~40 lines:

1. **The new file: `http/pricing.http`.** What it covers; the 25 request blocks; the order-of-operations guarantee.
2. **The publish-precondition demonstration.** Block `publishProductBeforeAnyPrice` is the canonical 409 demo. Calls before it bootstrap tax categories; calls after it show the flip.
3. **The Set vs. Schedule dispatch.** Block `schedulePriceForVariantA` proves the controller's dispatch logic from task-05 routes to the schedule path when `validFrom > now`. The microservice emits the right routing key (`catalog.price.scheduled`); the audit consumer (when `epic-11` lands) will see two distinct events even though both came through the same HTTP endpoint.
4. **The history preservation demo.** Block `getHistoricPriceAsOf` is the canonical proof that historic `asOf` queries are stable across future writes — append-only-for-history is observable at the read path.
5. **The unauthorized/forbidden coverage.** Two blocks confirm the `PermissionsGuard` + `pricing:write` requirement is in force.
6. **How to use the file from Neovim.** A one-paragraph pointer at the existing `nvim.md` if the project documents Kulala usage there. (Check `nvim.md` first.)

## Carryover produced (consumed by task-07 onward)

- `http/pricing.http` exists and exercises every endpoint.
- Doc 06 is now complete (api half + Kulala half).
- The file's `# Prereqs:` block names the seed state task-07 must produce.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); the new file is in `http/` and `eslint` does not lint http files, so this is automatic.
- [ ] `yarn test:unit` and `yarn test:e2e` are unaffected by this task — verify they still pass.
- [ ] Manual smoke: open `http/pricing.http` in Neovim with the Kulala plugin (or the equivalent IntelliJ HTTP client), execute the requests top-to-bottom, observe the expected status codes per the prose comments. The end state is product `1` published with both variants priced and tax-classified, and a future-effective scheduled price on variant A.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `06-pricing-api-and-kulala.md` has both halves filled — api (task-05) and Kulala flow (this task).
