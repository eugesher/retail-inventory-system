---
epic: epic-03
task_number: 8
title: Seed + docs + lint-fixtures finalization
depends_on: [1, 2, 3, 4, 5, 6, 7]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/07-currency-immutability-on-order.md
adr_deliverable: none
---

# Task 08 — Seed + docs + lint-fixtures finalization

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-019** (seeds are SQL under `scripts/seeds/`, applied by
`yarn test:seed`; idempotent), **ADR-017** (the architecture-lint fixtures + the
`eslint.config.mjs` boundaries are the durable enforcement of the new module's
isolation), and **ADR-024** (the `pricing:write` seed binding — already landed in
task-01; verify it here).

## Goal

Close the capability: seed the static TaxCategory set + a `USD` Price for every
seeded variant (so a published product is consistent and the read path returns a
seeded answer), write the forward-looking currency-on-order doc, bring `README.md`
and `CLAUDE.md` fully current, confirm the `pricing`-module architecture-lint
fixtures are in place and passing, and run the final self-containment gate.

## Entry state assumed

- task-01 → task-07 carryover present. The full pricing vertical works: domain +
  persistence + migration, the six RPCs + two events, the publish 409, the six
  gateway routes, `test/pricing.e2e-spec.ts`, and `http/pricing.http`.
- `scripts/test-db-seed.ts` already seeds `pricing:write` to `admin` +
  `catalog-manager` (task-01). `scripts/utils/test-db-seed.util.ts`
  `seedFiles` currently lists `product-stock.sql`, `order.sql`,
  `order-product.sql`, `catalog-product.sql`, `catalog-product-variant.sql` — the
  catalog products are seeded with `status='active'` directly (publish is not
  invoked), so the publish hard-fail does not gate the seed.
- The `tax_category` and `price` tables are empty in a fresh seed.
- `docs/implementation/03-pricing-price-and-tax-category/` holds docs `01`–`06`;
  `07` is not written. `README.md` and `CLAUDE.md` do not yet mention pricing
  (except the publish-line edits from task-01/05).
- The `pricing`-module arch-lint fixtures were added in task-01.

## Scope

**In**
- Seed: `scripts/seeds/tax-category.sql` (STANDARD/REDUCED/EXEMPT) +
  `scripts/seeds/price.sql` (one open `USD` Price per seeded variant); register
  both in `TestDbSeedUtil.seedFiles` in FK-safe order.
- Doc `07-currency-immutability-on-order.md`.
- `README.md`: Catalog → Pricing endpoints subsection; the "what is NOT cached"
  note; the `DEFAULT_CURRENCY` env entry; the seed-data table additions.
- `CLAUDE.md`: the `pricing/` sibling module in the catalog file tree; the new
  message patterns; the pricing↔catalog forbidden-import note.
- Verify the `pricing`-module arch-lint fixtures exist + pass; confirm
  `eslint.config.mjs` needs no new element (generic `apps/*/src/modules/*`
  patterns already classify pricing).
- The final self-containment grep across the whole tree.

**Out**
- Any behavior/code change to the pricing or catalog modules (this is a
  seed + docs + verification pass).

## Seed specifics

`scripts/seeds/tax-category.sql` — idempotent, fixed ids:

```sql
INSERT IGNORE INTO tax_category (id, code, name, description) VALUES
  (1, 'STANDARD', 'Standard rate',  'Default classification'),
  (2, 'REDUCED',  'Reduced rate',   'Reduced-band classification'),
  (3, 'EXEMPT',   'Exempt',         'Tax-exempt classification');
```

`scripts/seeds/price.sql` — one open (`valid_to IS NULL`) `USD` price per seeded
variant (`1`–`4`), with a **fixed past** `valid_from` (deterministic + idempotent;
not `NOW()`), fixed ids, `INSERT IGNORE` (re-runs ignore on PK; the
`open_scope_key` UNIQUE makes a duplicate open row a no-op anyway):

```sql
INSERT IGNORE INTO price (id, variant_id, currency, amount_minor, valid_from, valid_to, priority) VALUES
  (1, 1, 'USD', 4999,  '2020-01-01 00:00:00', NULL, 0),
  (2, 2, 'USD', 4999,  '2020-01-01 00:00:00', NULL, 0),
  (3, 3, 'USD', 19999, '2020-01-01 00:00:00', NULL, 0),
  (4, 4, 'USD', 19999, '2020-01-01 00:00:00', NULL, 0);
```

`scripts/utils/test-db-seed.util.ts` — append `'tax-category.sql'` and
`'price.sql'` to `seedFiles`. `price.sql` must come **after**
`catalog-product-variant.sql` (FK `price.variant_id → product_variant`). Do **not**
let `open_scope_key` appear in the `INSERT` column list (it is generated).
Attaching seeded TaxCategories to variants is optional and not required by the
exit criteria — if added, place it after both `tax-category.sql` and the variant
seed.

Re-running `yarn test:seed` twice must not error or duplicate rows.

## README.md updates

- **API → Catalog**: add a "Catalog → Pricing" subsection listing the six routes
  (the three `prices`/`price` routes + the three tax-category routes) with their
  methods, auth (`pricing:write` writes vs public reads), and bodies/queries.
- **Caching** "what is NOT cached": add a line that pricing reads are deliberately
  uncached until read volume warrants (the reserved `catalogPrice*` key shape
  exists for when it does).
- **Environment variables**: add `DEFAULT_CURRENCY=USD` (used by the publish
  precondition).
- **Seed-data table(s)**: add the three TaxCategories and the four `USD` prices.

## CLAUDE.md updates

- **Catalog microservice** section: add the `pricing/` sibling module to the
  file-listing snippet (the four-layer skeleton + `pricing.module.ts` at the
  module root), and note it shares `catalog_queue` and `DatabaseModule.forRoot`
  via the spread `pricingEntities`.
- **Message patterns** list: add rows for `catalog.price.set`,
  `catalog.price.list`, `catalog.price.select`, `catalog.price.changed`,
  `catalog.price.scheduled`, `catalog.tax-category.create`,
  `catalog.tax-category.list`, `catalog.variant.set-tax-category` (RPCs vs events;
  the price events ride `catalog_queue` with no consumer yet).
- **Forbidden-import note**: the pricing `domain/` must not import from `catalog/`
  directly — they communicate via the `variantId` (FK in persistence, opaque value
  in domain); the symmetric cross-table reads/writes (`price` probe from catalog;
  `product_variant.tax_category_id` from pricing) go through parameterized queries,
  never a cross-module entity import.
- Confirm the `catalog.product.publish` line already reflects the hard 409
  (task-05). If a `RBAC`/permissions paragraph enumerates permission codes, add
  `pricing:write` there.

## Architecture-lint + final gate

- Verify the `describe('boundaries/dependencies — pricing module', …)` fixtures
  (added in task-01) exist and pass under `yarn test:unit`; if any are missing,
  add them (mirror the catalog block). Confirm `eslint.config.mjs` needs **no**
  new element/rule for pricing (the generic patterns classify it) — do not weaken
  any rule.
- Run the self-containment gate and investigate every hit:
  ```bash
  grep -rniE 'tmp/|\bepic\b|\btask\b' \
    docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
  ```
  Remove any orchestration reference (and any pre-existing leak found). A genuine
  domain hit unrelated to this planning workflow is acceptable.

## Files to add

- `scripts/seeds/tax-category.sql`
- `scripts/seeds/price.sql`
- `docs/implementation/03-pricing-price-and-tax-category/07-currency-immutability-on-order.md`

## Files to modify

- `scripts/utils/test-db-seed.util.ts` — extend `seedFiles`.
- `README.md` — API / Caching / Environment / Seed-data sections.
- `CLAUDE.md` — catalog file tree, message patterns, forbidden-import note,
  permission-code mention.
- `spec/architecture-lint.spec.ts` — only if the pricing fixtures need to be
  added/repaired.

## Files to delete

None.

## Tests

- `yarn test:e2e` (full: infra reload → migrate → seed → test) is green; the seed
  now inserts the TaxCategories + the four `USD` prices; `test/pricing.e2e-spec.ts`
  still passes.
- After `yarn test:seed`,
  `GET /api/catalog/variants/1/price?currency=USD` returns the seeded price (and
  likewise for variants 2–4).
- `yarn test:seed` run twice is idempotent (no error, no duplicate rows).
- `yarn test:unit` green (the arch-lint fixtures included); `yarn lint` clean.

## Doc deliverable

`07-currency-immutability-on-order.md` — forward-looking: `currency` on `Price`
is the seed of `Order.currency`; a later cart/order capability resolves a
variant's applicable `Price` at place-time and stamps the order header's currency,
which is then immutable for that order (the multi-currency threshold). This
capability shapes that contract (the `(variantId, currency)` scope + Select
Applicable) without owning the order side. Describe by capability — no
epic/task numbers, no `tmp/` paths.

## Carryover to read

`carryover-01.md` … `carryover-07.md`.

## Carryover to produce

Write `carryover-08.md` — the closing note. Capture: the seed files added + the
`seedFiles` order; that README/CLAUDE are current; that the arch-lint fixtures
pass; the result of the final self-containment grep; and a one-paragraph
statement that the capability's cumulative exit criteria (below) are all met.
List the full verify command set.

## Exit criteria (this task closes the capability)

- [ ] `docker compose up -d && yarn migration:run && yarn start:dev && yarn test:seed`
      boots clean and seeds the three TaxCategories + a `USD` price for every
      seeded variant; the seed is idempotent.
- [ ] `GET /api/catalog/variants/:variantId/price?currency=USD` returns the seeded
      price for the seeded variants.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes (≥5 new pricing specs + the updated publish spec).
- [ ] `yarn test:e2e` passes; `test/pricing.e2e-spec.ts` + the concurrency test
      green; the publish-no-price 409 covered.
- [ ] Every request in `http/pricing.http` executes end-to-end.
- [ ] The at-most-one `valid_to IS NULL` per `(variantId, currency)` invariant
      holds (concurrency test).
- [ ] Docs `01`–`07` present under
      `docs/implementation/03-pricing-price-and-tax-category/`.
- [ ] `README.md` (API / Caching / Environment / Seed) and `CLAUDE.md` (catalog
      tree / message patterns / forbidden-import / permission code) are current.
- [ ] The `pricing`-module architecture-lint fixtures pass; no boundaries rule was
      weakened.
- [ ] The self-containment grep is clean across `docs/`, `apps/`, `libs/`,
      `http/`, `scripts/`, `spec/`, `migrations/`, `README.md`, `CLAUDE.md`.
- [ ] `carryover-08.md` is written.
