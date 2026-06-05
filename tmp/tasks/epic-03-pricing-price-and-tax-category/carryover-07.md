# Carryover 07 — Kulala `http/pricing.http`

State handed forward from task-07 to task-08 (the finalization task). Read this
after `carryover-01.md … carryover-06.md`.

## Entry state for task-08

`http/pricing.http` now exists — a runnable, top-to-bottom Kulala collection
covering every pricing/tax gateway route. **No code changed**; this task added one
`.http` file and completed one implementation doc. lint / format:check are green;
unit / e2e are untouched (no source delta) and were last proven green at end of
task-06 (475 unit / 68 suites; 95 e2e / 7 suites).

The file was **verified operationally** against a fresh `driver.sh start --reset`
stack (infra → migrate → seed → build → launch all 5): every block returned its
documented status/body, the public GETs worked with no token, and the writes 401'd
without the bearer (see "How to verify").

## What `http/pricing.http` contains

Eight `###`-separated blocks, each `# @name`d, in runnable order. Header comment
block cites
`apps/api-gateway/src/modules/catalog/presentation/catalog.controller.ts`, the
`/api/catalog` prefix note, and a `# Prereqs:` block (boot sequence
`docker compose up -d` → `yarn migration:run` → `yarn test:seed` →
`yarn start:dev`, the seeded admin login, the `pricing:write` write-gate /
public-read posture, and the fresh-DB note for a second run).

| # | `# @name` | Method · path | Auth | Result observed |
|---|---|---|---|---|
| 1 | `login` | `POST /auth/staff/login` (`admin@example.com`/`admin1234`) | — | `200`, captures `@accessToken` |
| 2 | `createTaxCategory` | `POST /catalog/tax-categories` | Bearer | `201` `TaxCategoryView` |
| 3 | `listTaxCategories` | `GET /catalog/tax-categories` | public | `200` `TaxCategoryView[]` |
| 4 | `setPriceVariant1` | `POST /catalog/variants/1/prices` | Bearer | `201` `PriceView` (4999, immediate) |
| 5 | `listPricesVariant1` | `GET /catalog/variants/1/prices?currency=USD` | public | `200` `PriceView[]` |
| 6 | `getApplicablePriceVariant1` | `GET /catalog/variants/1/price?currency=USD` | public | `200` `PriceView` (4999) |
| 7 | `schedulePriceVariant1` | `POST /catalog/variants/1/prices` | Bearer | `201` `PriceView` (5999, future) |
| 8 | `attachTaxCategoryVariant1` | `PATCH /catalog/variants/1/tax-category` | Bearer | `200` `VariantTaxHeaderView` |

### Captured / chosen variables (names the next session must respect)

- **`@baseUrl = {{ENV_BASE_URL}}`** — reused from `http/http-client.env.json`
  (`dev → http://localhost:3000/api`). **No new env var was needed** — the file
  list's optional `http-client.env.json` edit was correctly skipped.
- **`@accessToken = {{login.response.body.$.accessToken}}`** — the seeded admin
  bearer; substituted into every write's `Authorization` header.
- **`@taxCode = LUXURY`** — defined as a file-level variable (single source) and
  fed into BOTH the `createTaxCategory` body and the `attachTaxCategoryVariant1`
  body. `LUXURY` is deliberately **not** a seeded tax code, so block 2 creates
  cleanly on a fresh seed (a repeat → `409 TAX_CATEGORY_CODE_TAKEN`).

### Seeded fixtures the file targets

Catalog seed (`scripts/seeds/catalog-product*.sql`): products `1`
(`aurora-desk-lamp`), `2` (`nimbus-office-chair`); variants `1` (`AURORA-WARM`),
`2` (`AURORA-COOL`), `3` (`NIMBUS-BLACK`), `4` (`NIMBUS-GREY`). The flow drives
variant **`1`**. `pricing:write` is seeded to `admin` + `catalog-manager`.

## Key behaviors confirmed by the live run (for task-08's awareness)

- **Self-containment holds**: Set-before-Get (block 4 before 5/6) and
  Create-before-attach (block 2 before 8) ran on a DB with **zero** price/tax seed
  rows.
- **Schedule tiling**: after block 7 scheduled a future `validFrom`
  (`2030-01-01T00:00:00.000Z`), the predecessor (block-4 row) was **closed at that
  instant** — its `validTo` became `2030-01-01T00:00:00.000Z` (the "append +
  close open predecessor" behavior). The current applicable read (`asOf=now`) was
  unchanged (4999); `?asOf=2030-01-01T00:00:01.000Z` returned the scheduled 5999.
- **A second full run wants a fresh DB**: the `LUXURY` `code` is unique and, after
  the future price is scheduled, a fresh immediate Set against the same
  `(variant 1, USD)` scope conflicts on the single-open-row invariant. The header
  documents `yarn test:infra:reload` between runs.
- **`validFrom` literal is far-future on purpose**: `2030-01-01T00:00:00.000Z` so
  the file runs as-is (the domain rejects a past `validFrom` with
  `PRICE_VALID_FROM_IN_PAST`). The block comment documents computing a realistic
  `~1h`-ahead UTC ISO-8601 timestamp for a live demo.

## Files added / modified

**Added**

- `http/pricing.http`
- `tmp/tasks/epic-03-pricing-price-and-tax-category/carryover-07.md` (this file)

**Modified**

- `docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md`
  — completed §7 (the Kulala flow table, the Set-before-Get self-containment
  rationale, the future-`validFrom` scheduling demonstration). Relative links to
  `http/pricing.http`, `http/catalog.http`, `http/http-client.env.json`.

**Deleted** — none.

`README.md` / `CLAUDE.md` were **not** touched: this task added no gateway endpoint
and neither file enumerates the `.http` collection. Their pricing-relevant updates
(seed-data tables, `DEFAULT_CURRENCY` env-var row) belong to task-08.

## Known gaps / deferrals (all owned by task-08, the finalization task)

- **Price/tax seed rows** (+ variant tax attachments) in `scripts/test-db-seed.ts`
  / `scripts/seeds/` — still absent. `tax_category` and `price` are empty on a
  fresh seed (only what this `.http` / the e2e create). Keep the seed idempotent.
- **`README.md` / `CLAUDE.md`** — the seed-data table for the new price/tax rows
  and the `DEFAULT_CURRENCY` env-var row.
- **`docs/implementation/03-pricing-price-and-tax-category/07-currency-immutability.md`**
  — the currency-immutability doc (not yet written).
- **Final lint-fixture / self-containment grep sweep** across the whole tree.

## How to verify (all green at end of task-07)

- `yarn format:check` — clean (Prettier covers the edited `.md`).
- `yarn lint` — exit 0 (`--max-warnings 0`). No source delta.
- Operational (the real exit criterion — `.http` files are run, not unit-tested):
  1. `./.claude/skills/run-retail-inventory-system/driver.sh start --reset`
     (infra → migrate → seed → build → launch all 5 services).
  2. Run `http/pricing.http` top-to-bottom in a Kulala client (or `curl` each
     block in order — `login` first to capture the bearer). Expect:
     `201` create-tax / `200` list-tax / `201` set-price / `200` list-prices /
     `200` get-price / `201` schedule-price / `200` attach. Public GETs work with
     **no** `Authorization` header; writes without the bearer return `401`.
  3. `./.claude/skills/run-retail-inventory-system/driver.sh stop`.
- Self-containment grep clean on this task's artifacts:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' http/pricing.http docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md`
  → no matches.
- Full e2e (`yarn test:e2e`, 95 / 7) is unaffected by this task (no source delta)
  and remains the automated reference for the same request/response shapes; it was
  last proven green at end of task-06.
