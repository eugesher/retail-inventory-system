---
epic: epic-03
task_number: 7
title: Kulala http/pricing.http
depends_on: [1, 2, 3, 4, 5, 6]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md
adr_deliverable: none
---

# Task 07 — Kulala `http/pricing.http`

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

`tmp/tasks/execution-requirements.md` §9 (Kulala HTTP files) governs the file
shape: `@baseUrl = {{ENV_BASE_URL}}`, `###` separators, a `# @name <id>` per
request, header comments citing the controller path + body/query shape, and a
`# Prereqs:` block with the seeded login capturing `@accessToken`. No `tmp/`,
"epic", or "task" references.

## Goal

Author `http/pricing.http` — a runnable, top-to-bottom Kulala file covering every
pricing/tax gateway route: Set Price, Schedule Price (future `validFrom`), list
prices, the single applicable price (Select Applicable), create + list
TaxCategory, and attach a TaxCategory to a variant. Then verify every request
executes end-to-end against a migrated + seeded stack.

## Entry state assumed

- task-01 → task-06 carryover present. The six gateway routes exist under
  `/api/catalog/...` with the documented guards; the catalog microservice handles
  the RPCs. `PRICING_WRITE` is seeded to `admin`.
- The seeded catalog fixtures from the catalog capability: products `1`
  (`aurora-desk-lamp`) and `2` (`nimbus-office-chair`), and variants `1`
  (`AURORA-WARM`), `2` (`AURORA-COOL`), `3` (`NIMBUS-BLACK`), `4` (`NIMBUS-GREY`).
- The price/tax **seed rows do not exist yet** (task-08 adds them), so this file
  must be **self-contained**: it Sets a price before it Gets one, and it Creates a
  TaxCategory before it attaches one.
- `http/catalog.http` is the style template (the seeded admin login block + the
  `@accessToken` capture + the header-comment conventions).

## File shape

`http/pricing.http`:
- Header comment block: cite
  `apps/api-gateway/src/modules/catalog/presentation/catalog.controller.ts`, the
  `/api/catalog` prefix note, and a `# Prereqs:` block — the same boot sequence
  (`docker compose up -d` → `yarn migration:run` → `yarn test:seed` →
  `yarn start:dev`), the seeded admin login captured into `@accessToken`, and a
  note that the write routes need `pricing:write` (held by `admin` +
  `catalog-manager`) while the GET reads are public (send no token). State that a
  second full run wants a fresh DB (re-seed with `yarn test:infra:reload`) because
  the TaxCategory `code` and the open-price rows are unique/stateful.
- `@baseUrl = {{ENV_BASE_URL}}`.
- Blocks, in runnable order (each `###`-separated, each `# @name`):
  1. `login` — `POST /api/auth/staff/login` (`admin@example.com` / `admin1234`);
     `@accessToken = {{login.response.body.$.accessToken}}`.
  2. `createTaxCategory` — `POST /api/catalog/tax-categories` (Bearer) with a code
     that is **not** in the seeded set (e.g. `{ "code": "LUXURY", "name": "Luxury
     goods", "description": "Higher-band classification" }`) so the file stays
     runnable on a freshly-seeded DB; capture `@taxCode = LUXURY`.
  3. `listTaxCategories` — `GET /api/catalog/tax-categories` (public); the created
     category appears (alongside the seeded `STANDARD`/`REDUCED`/`EXEMPT` once
     task-08 seeds them).
  4. `setPriceVariant1` — `POST /api/catalog/variants/1/prices` (Bearer)
     `{ "currency": "USD", "amountMinor": 4999, "priority": 0 }` (immediate Set,
     `validFrom` omitted ⇒ now). Response `PriceView`.
  5. `listPricesVariant1` — `GET /api/catalog/variants/1/prices?currency=USD`
     (public); the just-set price is in effect.
  6. `getApplicablePriceVariant1` — `GET /api/catalog/variants/1/price?currency=USD`
     (public); the single applicable `PriceView`.
  7. `schedulePriceVariant1` — `POST /api/catalog/variants/1/prices` (Bearer) with
     a **future** `validFrom` (document computing/pasting an ISO timestamp ~1h
     ahead) and a higher `priority`; response `PriceView`. A header comment notes
     the current applicable answer is unchanged until `validFrom`, and a
     `?asOf=<future ISO>` on block 6's URL would return this scheduled price.
  8. `attachTaxCategoryVariant1` — `PATCH /api/catalog/variants/1/tax-category`
     (Bearer) `{ "taxCategoryCode": "{{taxCode}}" }`; response
     `VariantTaxHeaderView` carrying the attached code.
- Header comments per block: the controller path, the body/query shape, the auth
  posture, and what each captured variable feeds.

## Files to add

- `http/pricing.http`

## Files to modify

- `docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md`
  — complete the Kulala half (the sample flow, the set-before-get
  self-containment, the future-`validFrom` scheduling note).
- `http/http-client.env.json` — only if a new env var is needed (it should not be;
  reuse `ENV_BASE_URL`).

## Files to delete

None.

## Tests

- No automated spec. Verification is operational: boot the stack
  (`docker compose up -d` → `yarn migration:run` → `yarn test:seed` →
  `yarn start:dev`) and run every block top-to-bottom; each returns its expected
  status (`201`/`200`) with the documented body. Confirm the public GETs work with
  no `Authorization` header and the writes are rejected without the bearer token.
- `yarn lint` / `yarn test:unit` / `yarn test:e2e` remain green (no code change).

## Doc deliverable

Complete `06-pricing-api-and-kulala.md` (started in task-06): the Kulala flow,
why it Sets before it Gets (self-containment independent of the seed), and the
future-`validFrom` scheduling demonstration.

## Carryover to read

`carryover-01.md` … `carryover-06.md`.

## Carryover to produce

Write `carryover-07.md`. Capture: that `http/pricing.http` exists and every block
runs; the captured variable names (`@accessToken`, `@taxCode`); the
non-seed TaxCategory code chosen for the create block; the seeded variant ids the
file targets. Note the only remaining gap (the price/tax seed rows + README/CLAUDE
+ the `07-currency-immutability` doc + the final lint-fixture/grep sweep →
task-08). Verify commands.

## Exit criteria

- [ ] `http/pricing.http` covers Set, Schedule, list prices, single applicable
      price, create + list TaxCategory, and attach-to-variant; it runs
      top-to-bottom on a freshly migrated + seeded stack.
- [ ] The file is self-contained (Sets before it Gets; Creates a non-seed
      TaxCategory before it attaches).
- [ ] The public GETs work without a token; the writes require the bearer.
- [ ] `06-pricing-api-and-kulala.md` is complete.
- [ ] `yarn lint`, `yarn test:unit`, `yarn test:e2e` remain green.
- [ ] The self-containment grep is clean (no `tmp/`, "epic", "task" in
      `http/pricing.http` or the doc).
- [ ] `carryover-07.md` is written.
