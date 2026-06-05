# Carryover 08 — Seed + docs + lint-fixtures finalization (capability close)

The closing note for the pricing (Price + TaxCategory) capability. Read this after
`carryover-01.md … carryover-07.md`. This task added the static seed rows, wrote
the forward-looking currency-on-order doc, brought `README.md` current, confirmed
the `pricing`-module arch-lint fixtures pass, and ran the final self-containment
gate. **No business/code change to the pricing or catalog modules** — this was a
seed + docs + verification pass, exactly as scoped.

## Entry state (now on disk / in the schema)

A fresh `yarn test:seed` now loads the static pricing fixture on top of the catalog
products/variants:

- **`tax_category`** — 3 rows, fixed ids: `1 STANDARD`, `2 REDUCED`, `3 EXEMPT`
  (labels only, no rate). None attached to a variant by default
  (`product_variant.tax_category_id` stays NULL until a PATCH attaches one).
- **`price`** — 4 rows, fixed ids `1..4`, one open (`valid_to IS NULL`) `USD` price
  per seeded variant `1..4`: variants 1–2 `amount_minor = 4999` ($49.99), variants
  3–4 `amount_minor = 19999` ($199.99). `valid_from = '2020-01-01 00:00:00'`
  (a fixed *past* instant — deterministic, never `NOW()`); `priority = 0`.

So a seeded variant now resolves to a seeded price, and a seeded product would
satisfy the publish active-price precondition in `DEFAULT_CURRENCY` (`USD`). The
catalog products are still seeded with `status='active'` directly (publish is not
invoked in the seed), so the seed itself never trips the publish hard-fail.

## Files added

- `scripts/seeds/tax-category.sql` — `INSERT IGNORE` of the 3 labels (fixed ids).
- `scripts/seeds/price.sql` — `INSERT IGNORE` of the 4 open `USD` prices (fixed
  ids). The generated column `open_scope_key` is **deliberately absent** from the
  `INSERT` column list (MySQL computes it; naming it would error). Comment header
  documents the fixed-past `valid_from` and the FK ordering.
- `docs/implementation/03-pricing-price-and-tax-category/07-currency-immutability-on-order.md`
  — forward-looking: `Price.currency` (half of the `(variantId, currency)` ledger
  identity) seeds a future `Order.currency`; the order side must **capture** the
  resolved `amountMinor` (not hold a live ledger ref) and **freeze** a single
  header currency (the multi-currency threshold). Describes by capability — no
  epic/task numbers, no `tmp/` paths. Cross-links docs 02 / 05 and ADR-013 / ADR-026.
- `tmp/tasks/epic-03-pricing-price-and-tax-category/carryover-08.md` (this file).

## Files modified

- `scripts/utils/test-db-seed.util.ts` — appended `'tax-category.sql'` then
  `'price.sql'` to `TestDbSeedUtil.seedFiles`, **after** `catalog-product-variant.sql`.
  Final order:
  `product-stock.sql → order.sql → order-product.sql → catalog-product.sql →
  catalog-product-variant.sql → tax-category.sql → price.sql`.
  FK-safe: `price.variant_id → product_variant.id`, so `price.sql` must follow the
  variant seed; `tax_category` has no FK dependency.
- `README.md` — four edits:
  1. **API → Catalog**: a note on the publish active-price precondition + a
     `DEFAULT_CURRENCY` (default `USD`) env-var row. (The six pricing/tax routes
     themselves were already documented by task-06.)
  2. **Caching → "What is not cached"**: a new subsection — pricing reads go
     straight to MySQL; the reserved `CACHE_KEYS.catalogPrice(...)`
     (`ris:catalog:price:v1:<variantId>:<currency>`) key shape exists for when read
     pressure warrants, but no module imports `CacheModule` for it yet.
  3. **Local development (seed data)**: three new tables — the 4 seeded
     variants (so the price rows are legible), the 3 tax categories, and the 4 `USD`
     prices — plus an idempotency + read-path note.

## Files NOT changed (verified already current / correct)

- **`CLAUDE.md`** — already fully current from the incremental task-01/03/04/05/06
  updates: the `modules/pricing/` sibling is in the architecture tree; the
  `catalog_queue` + combined `DatabaseModule.forRoot([...catalogEntities,
  ...pricingEntities])` note is present; all six pricing/tax RPCs + the two
  `catalog.price.{changed,scheduled}` events are in the message-pattern list; the
  pricing↔catalog forbidden-import note (opaque `variantId`, parameterized FK
  read/write, no cross-module entity import) is present both directions; the
  `catalog.product.publish` line already states the hard **409
  `PRODUCT_PUBLISH_REQUIRES_PRICE`**; and `pricing:write` already appears in the
  gateway-routes permission line. **No CLAUDE.md edit was needed.**
- **`spec/architecture-lint.spec.ts`** — the
  `describe('boundaries/dependencies — pricing module', …)` block (7 fixtures,
  added in task-01) is present and **passing**, including the pricing→catalog
  domain cross-module bumper. No `eslint.config.mjs` change is needed — the generic
  `apps/*/src/modules/*/<layer>/**` element patterns classify pricing
  automatically. **No rule was weakened.**
- **`.env.example` / `.env.local` / `docker-compose.yml`** — `DEFAULT_CURRENCY=USD`
  already landed in task-05; only the README row was outstanding (now added).

## Files deleted

- None.

## Final self-containment grep — clean

```bash
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```

→ **no matches** (exit 1). No orchestration reference leaked into any deliverable;
no pre-existing leak found.

## How to verify (all green at end of task-08)

- `yarn format:check` — clean (Prettier covers the edited `.md` + `.ts`; `.sql`
  files are not in its glob).
- `yarn lint` — exit 0 (`--max-warnings 0`). No source delta; no boundary change.
- `yarn test:unit` — **475 tests / 68 suites** pass (unchanged baseline; the
  `pricing`-module arch-lint fixtures are part of `spec/architecture-lint.spec.ts`).
- `yarn test:e2e` — **95 tests / 7 suites** pass on a fresh infra reload → migrate
  → seed; the seed now inserts the 3 tax categories + 4 `USD` prices and
  `✓ Database seeded successfully` prints; `test/pricing.e2e-spec.ts` (incl. the
  publish-no-price 409 and the single-open-row concurrency test) is green.
- **Seed idempotency** — `yarn test:seed` run a second time prints
  `✓ Database seeded successfully` with no error; verified in MySQL:
  - `tax_category` ids 1–3 present (STANDARD/REDUCED/EXEMPT); no duplicate `code`.
  - `price` ids 1–4 present (variant 1–4, USD, 4999/4999/19999/19999,
    `valid_from='2020-01-01 00:00:00'`, `valid_to IS NULL`, `priority=0`); exactly
    **one** open USD row per `(variant_id)` scope (the at-most-one-open invariant
    holds across re-seeds).
- **Live read path** — with all 5 services up
  (`./.claude/skills/run-retail-inventory-system/driver.sh start`):
  `GET /api/catalog/variants/{1,2,3,4}/price?currency=USD` each returns the seeded
  `PriceView` (`amountMinor` 4999/4999/19999/19999, `validFrom`
  `2020-01-01T00:00:00.000Z` — exact UTC, confirming the task-06 `timezone:'Z'`
  fix), `validTo: null`. `GET /api/catalog/tax-categories` (public) lists the 3
  seeded labels. `driver.sh stop` afterwards.

## Capability exit criteria — all met

The pricing (Price + TaxCategory) capability is **closed**. Cumulatively across
tasks 01–08: the colocated `pricing` module owns the append-only `price` ledger and
the `tax_category` label (domain + persistence + the `CreatePricingTables`
migration); the six RPCs on `catalog_queue` (Set/Schedule, List, Select Applicable,
Tax-Category Create/List, Variant Tax-Category Attach) plus the two
`catalog.price.{changed,scheduled}` events are wired; the catalog
`PublishProductUseCase` hard-fails **409** when a variant lacks an in-effect
`DEFAULT_CURRENCY` price (parameterized `price`-table probe, no pricing import); the
six gateway routes front them at `/api/catalog/...` (`pricing:write` writes, public
reads); `test/pricing.e2e-spec.ts` (19 tests incl. the publish 409 and the
single-open-row concurrency invariant) and `http/pricing.http` exercise the surface
end-to-end; the static seed (3 tax categories + a `USD` price per seeded variant) is
in place and idempotent; the `pricing`-module architecture-lint fixtures pass with
no rule weakened; `README.md` and `CLAUDE.md` are current; and the self-containment
grep is clean across the whole tree. lint / format / unit (475/68) / e2e (95/7) are
all green.

### Full verify command set

```bash
docker compose up -d mysql redis rabbitmq      # infra (or yarn test:infra:up)
yarn migration:run                              # apply migrations incl. CreatePricingTables
yarn test:seed                                  # seed 3 tax categories + 4 USD prices (idempotent — run twice)
yarn format:check                               # Prettier (CI gate)
yarn lint                                        # ESLint --max-warnings 0 (incl. boundaries/*)
yarn test:unit                                   # 475 / 68 (incl. pricing arch-lint fixtures)
yarn test:e2e                                     # 95 / 7 (infra reload → migrate → seed → tests)
# Live read path (optional, proves the seeded rows resolve over HTTP):
./.claude/skills/run-retail-inventory-system/driver.sh start
for v in 1 2 3 4; do curl -s "http://localhost:3000/api/catalog/variants/$v/price?currency=USD"; echo; done
curl -s http://localhost:3000/api/catalog/tax-categories; echo
./.claude/skills/run-retail-inventory-system/driver.sh stop
# Self-containment gate:
grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```
