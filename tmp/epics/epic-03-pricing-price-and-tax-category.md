---
id: epic-03
title: Pricing foundation — Price + TaxCategory, colocated with catalog
source_stages: [walking-skeleton]
depends_on: [epic-02]
microservices: [api-gateway, catalog-microservice]
task_subfolder: tmp/tasks/epic-03-pricing-price-and-tax-category/
docs_subfolder: docs/implementation/epic-03-pricing-price-and-tax-category/
---

# Epic 03 — Pricing foundation — Price + TaxCategory, colocated with catalog

## Goal

Add a money layer to the catalog. Implement `Price` (currency-scoped, time-bounded, append-only-for-history) and `TaxCategory` (classification label only — actual rates remain external) inside the existing `catalog-microservice` as a sibling `pricing` module. Expose Set Price, Schedule Price, and Select Applicable Price so downstream `CartLine`/`OrderLine` can snapshot a deterministic price at write time. Wire `epic-02`'s deferred publish precondition ("≥1 active Price for the variant") as a hard rule. After this epic, the catalog can serve a variant id → current price answer with `(variantId, currency, asOf)` resolution semantics.

## In-Scope Entities and Operations

- **Price**: `id`, `variantId` (FK to `product_variant`), `currency` (ISO-4217, 3-char), `amountMinor` (INT, integer minor units — e.g. cents), `validFrom` (timestamp), `validTo` (timestamp nullable), `priority` (INT, default 0), `createdAt`, `updatedAt`. Append-only for history: edits create a new row (with `validFrom` = now, ending the previous row's `validTo` = now); rows are never UPDATEd in place once `validFrom` is in the past.
- **TaxCategory**: `id`, `code` (unique, e.g. `STANDARD` / `REDUCED` / `EXEMPT`), `name`, `description`.
- **product_variant.tax_category_id** column added (nullable FK).
- **Operations:**
  - **Set Price** (User; `pricing:write`) — append a new Price row valid from now (or from a future `validFrom`); ends the predecessor's `validTo` if currency-scoped collision exists. Emits `PriceChanged`.
  - **Schedule Price** (User; `pricing:write`) — same as Set Price but with `validFrom > now`. Emits `PriceScheduled` (a variant of `PriceChanged` with a `effectiveAt` field).
  - **Select Applicable Price** (System; internal port) — given `(variantId, currency, asOf=now)`, return the highest-priority Price row whose `validFrom ≤ asOf < validTo (or validTo IS NULL)`. Used by the cart-line and order-line snapshot paths in `epic-05`.
  - **List TaxCategory** (Customer/User; read) and **Create TaxCategory** (User; `pricing:write`) — small static set seeded at install.

## Non-Goals

- **Discounts, promotions, coupons, gift cards** — Exclusions Register (`epic-15`).
- **Customer-group / B2B contract / tiered / volume / dynamic pricing** — Exclusions Register (`epic-15`).
- **Tax rate computation, jurisdiction tables, currency conversion** — Exclusions Register (`epic-15`). This epic only stores classification, not rates.
- **MSRP vs sale price (struck-through pricing)** — Exclusions Register (`epic-15`).
- **Multi-channel/country price scope (commercetools-style)** — out of scope; `(variantId, currency)` is the only scope axis in this epic.

## Architectural Decisions Honored

- **Cross-Cutting "Soft delete vs hard delete":** Price is append-only (the report classifies it under the "soft delete (deactivate)" set for catalog content, but in the audit-fidelity section a Price change is explicitly auditable; we implement it as **append-only-for-history** — never UPDATE a Price row whose `validFrom ≤ now`; instead create a new row and close the predecessor's `validTo`). Effectively a closed/open interval ledger.
- **Cross-Cutting "Auditability":** "Every Price change" is one of the always-audit cases. This epic emits `PriceChanged` to the event stream (consumed by the audit/event-store microservice once `epic-11` lands); per-row immutability is enforced by the append-only convention.
- **Cross-Cutting "Multi-location / multi-warehouse":** Price is deliberately NOT location-aware in the universal core; per-store pricing is the first natural extension (lifts via a future `priceScope` field). This epic does not add `priceScope` or `stockLocationId` to Price.
- **Open Question Q4 (forward-looking — separate paymentStatus on Order):** the existence of `currency` on Price flows into `Order.currency` (immutable on the Order header per the report's Stage 1 multi-currency threshold); the `Order` entity in `epic-05` will inherit `currency` from the cart's resolved Prices.
- **ADR-004 / 009 / 012 / 013** (per-module hexagonal): the new `pricing` module inside `catalog-microservice` follows the canonical template (siblings: `domain/application/infrastructure/presentation`).
- **ADR-008** (dotted routing keys): new routing keys `catalog.price.changed`, `catalog.price.scheduled` are added to `libs/messaging/routing-keys.constants.ts` (kept under `catalog.*` since pricing colocates with catalog).
- **ADR-016 + ADR-022** (cache keys + schema version): if pricing reads are later cached (likely once read volume grows), the key convention is `ris:catalog:price:v1:<variantId>:<currency>`. Builder added to `libs/cache/cache-keys.ts`; constant `CATALOG_PRICE_KEY_VERSION = 'v1'`. This epic does NOT yet wire a cache on the read path — the report's threshold for caching pricing is unmet.
- **ADR-017** (architecture lint): no new microservice, but `pricing` is a new module inside `catalog-microservice` and must pass the existing module-isolation rules.
- **ADR-019** (TypeORM + MySQL): new tables via fresh migration.
- **ADR-010** (RBAC at the gateway): write endpoints behind `@RequiresPermission('pricing:write')`; read endpoints public. The `pricing:write` permission code is seeded by this epic (epic-01's seed floor is extended).

## Persistence Changes

**Added (in catalog-microservice):**

- `price` table: `id` (BIGINT PK), `variant_id` (FK to `product_variant`), `currency` (CHAR(3)), `amount_minor` (BIGINT), `valid_from` (TIMESTAMP), `valid_to` (TIMESTAMP nullable), `priority` (INT default 0), timestamps.
- `tax_category` table: `id` (INT PK), `code` (VARCHAR(50) unique), `name`, `description`.
- New column on `product_variant`: `tax_category_id` (INT FK nullable).

**Removed:** none.

**Indexes & constraints:**

- Composite index on `(variant_id, currency, valid_from DESC)` for the read-path resolution.
- Unique partial constraint on `(variant_id, currency)` where `valid_to IS NULL` — at most one open-ended row per scope. Enforced by an application-level check inside `SetPriceUseCase` (closing the predecessor's `valid_to` before inserting); a DB-level partial unique index is added on engines that support it.
- FK `price.variant_id → product_variant.id ON DELETE RESTRICT` (variant archival ≠ deletion; Price rows survive).
- FK `product_variant.tax_category_id → tax_category.id ON DELETE SET NULL`.

## Eventing / Messaging

- **New routing keys (added to `libs/messaging/routing-keys.constants.ts`, under `catalog.*` namespace):**
  - `catalog.price.changed` — emitted on Set Price; payload: `{ variantId, currency, amountMinor, validFrom, validTo (nullable), priority, eventVersion: 'v1', correlationId }`.
  - `catalog.price.scheduled` — emitted on Schedule Price (when `validFrom > now`); payload includes `effectiveAt`.
- **No new queue** — the existing `catalog_queue` (from `epic-02`) carries the pricing RPCs (`catalog.price.set`, `catalog.price.list`, `catalog.price.select` for variant-id-to-current-price internal lookups).
- **No new consumer** in this epic — the audit/event-store consumer of `catalog.price.changed` is owned by `epic-11`.

## API Surface

**New HTTP endpoints in `api-gateway`** (added to `modules/catalog/` from `epic-02`):

| Method | Path | Body / params | Auth | Response |
|---|---|---|---|---|
| `POST` | `/api/catalog/variants/:variantId/prices` | `{ currency, amountMinor, validFrom?, validTo?, priority? }` | bearer + `pricing:write` | newly inserted Price row |
| `GET` | `/api/catalog/variants/:variantId/prices` | query: `?currency=USD&asOf=…` | `@Public()` | list of Price rows in effect for the query (defaults to currency=`USD` and asOf=`now`) |
| `GET` | `/api/catalog/variants/:variantId/price` | query: `?currency=USD&asOf=…` | `@Public()` | the single applicable Price (uses Select Applicable Price logic) |
| `POST` | `/api/catalog/tax-categories` | `{ code, name, description }` | bearer + `pricing:write` | new TaxCategory |
| `GET` | `/api/catalog/tax-categories` | — | `@Public()` | list all TaxCategories |
| `PATCH` | `/api/catalog/variants/:variantId/tax-category` | `{ taxCategoryCode }` | bearer + `pricing:write` | updated variant header |

**Modified:** `POST /api/catalog/products/:productId/publish` (from `epic-02`) **hard-fails** if any variant has no active Price in the seeded `DEFAULT_CURRENCY` (env var, default `USD`). The previous warning path is removed.

**Kulala HTTP files** (under `http/`):

- **`http/pricing.http`** — NEW; covers Set Price, Schedule Price (validFrom in the future), Select Applicable Price, list/create TaxCategory, attach TaxCategory to a Variant. Header `# Prereqs:` cites the seeded admin token + the variant ids from epic-02's seed.

## Test Strategy

**Unit tests:**

- `apps/catalog-microservice/src/modules/pricing/domain/spec/price.model.spec.ts` — append-only invariant (constructing a Price with `validFrom` strictly before `now` is allowed only via the "import historical" code path; the standard `set` path forbids it); `validFrom < validTo` invariant when `validTo` is set; `amountMinor ≥ 0`; `currency` 3-char ISO-shape.
- `apps/catalog-microservice/src/modules/pricing/domain/spec/tax-category.model.spec.ts` — `code` is `UPPER_SNAKE_CASE`; uniqueness asserted via test double.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/spec/set-price.use-case.spec.ts` — opens a new Price; if a predecessor exists with `valid_to IS NULL`, closes its `valid_to` to the new `valid_from` in the **same transaction**; emits `PriceChanged`.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/spec/schedule-price.use-case.spec.ts` — `validFrom > now` required; emits `PriceScheduled`; future-effective Prices do not change the current Select Applicable answer.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/spec/select-applicable-price.use-case.spec.ts` — resolution by `priority DESC`, `validFrom DESC`; tiebreak rule; returns null when no Price in scope.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts` — UPDATED from epic-02: now hard-fails when any variant lacks an active Price.

**E2E tests:**

- `test/pricing.e2e-spec.ts`:
  1. Admin tries to publish a Product whose variants have no Price → `409` (or `422`, see decision in task 4 docs).
  2. Admin Sets Prices for both variants → `200`.
  3. Admin publishes Product → `200`, status active.
  4. Customer hits `GET /api/catalog/variants/:variantId/price?currency=USD` and sees the current Price.
  5. Admin Schedules a future Price (validFrom = now + 1h, higher priority) — the current Price answer is unchanged; querying `asOf=now+2h` returns the future Price.
  6. Admin Sets a new Price now — the old open-ended row is closed (`validTo = newPrice.validFrom`); historic queries (`asOf=old-validFrom`) still return the old Price.

**Concurrency tests:** at-most-one-open-Price-per-`(variantId, currency)` concurrency test — two `SetPrice` calls landing within ms of each other must both succeed or one must lose with a clear error; the test ensures no `validTo IS NULL` collisions persist.

**Seed data required:**

- Three seeded TaxCategories: `STANDARD`, `REDUCED`, `EXEMPT`.
- One active Price in `USD` for each of epic-02's seeded variants (so the publish hard-fail does not break the seed).
- Permission code `pricing:write` seeded into roles `admin` and `catalog-manager`.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/epic-03-pricing-price-and-tax-category/`:

- `01-pricing-module-scaffold.md` — sibling module inside catalog-microservice; boundaries lint rules; new routing keys.
- `02-price-domain-and-append-only-history.md` — append-only-for-history rationale, `(variantId, currency)` scope, the closed/open interval ledger.
- `03-tax-category-and-variant-attachment.md` — classification-only semantics; rate computation explicitly deferred (link to `docs/extensions/tax-computation-engine.md` once `epic-15` lands).
- `04-publish-precondition-hard-fail.md` — what changed in epic-02's publish path; chosen HTTP status code rationale.
- `05-select-applicable-price.md` — resolution algorithm, tiebreak rule, test fixtures.
- `06-pricing-api-and-kulala.md` — endpoint shapes, the read path, sample HTTP file flow.
- `07-currency-immutability-on-order.md` — forward-looking note: `Order.currency` will be set from the resolved Prices at place-time in epic-05; this epic shapes the contract.

**`README.md` updates required:**

- Extend **API → Catalog** with the pricing endpoints under a "Catalog → Pricing" subsection.
- Add a paragraph in the **Caching** section's "What is NOT cached" note: pricing reads are deliberately uncached until volume warrants.
- Add **Environment variables** entry: `DEFAULT_CURRENCY=USD` (used by the publish precondition).

**`CLAUDE.md` updates required:**

- Under **Catalog microservice** (from epic-02), add the `pricing/` sibling module to the file-listing snippet.
- Add a row in the **Message patterns** list for `catalog.price.changed` / `catalog.price.scheduled`.
- Add a forbidden-import note: pricing/`domain/` must not import from `catalog/` directly — they communicate via the variant id (FK in persistence, opaque value in domain).

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Add the `pricing/` sibling module scaffolding** inside `catalog-microservice` (`domain/application/infrastructure/presentation` skeleton, eslint boundaries update, fixture spec extension).
2. **Add Price + TaxCategory domain + persistence + repository ports/adapters.** Migration creates `price`, `tax_category`, adds `product_variant.tax_category_id`.
3. **Implement Set Price + Schedule Price + Select Applicable Price use cases.** Specs + event publisher emission.
4. **Update Publish Product (epic-02) to hard-fail on missing Price.** Update its spec to assert the new behavior. Choose HTTP status code (recommend `409 Conflict` — "preconditions not met to publish").
5. **Add the api-gateway pricing endpoints.** Reuse `modules/catalog/` from epic-02; add new controllers/use-cases/DTOs/pipes.
6. **Author `http/pricing.http`.**
7. **Seed + docs pass:** extend seed, write the seven `docs/implementation/.../*.md` files, update `README.md` + `CLAUDE.md`, extend `spec/architecture-lint.spec.ts`.

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-02` complete; catalog-microservice boots; products + variants exist in seed. | New `apps/catalog-microservice/src/modules/pricing/` skeleton; updated `eslint.config.mjs`; `spec/architecture-lint.spec.ts` extended; `docs/implementation/epic-03-…/01-…md`. |
| 2 | Task 1 carryover present. | `price.model.ts`, `tax-category.model.ts`, entities, mappers, repositories; new migration; `02-…md`, `03-…md`. |
| 3 | Tasks 1–2 carryover present. | Three use cases + specs; updated `MicroserviceClientCatalogModule` to expose RPC patterns; routing keys added; `05-…md`. |
| 4 | Tasks 1–3 carryover present. | Updated `publish-product.use-case.ts` + its spec; `04-…md`. |
| 5 | Tasks 1–4 carryover present. | `apps/api-gateway/src/modules/catalog/`: new controller methods, use cases, DTOs, pipes; `06-…md`. |
| 6 | Task 5 carryover present. | New `http/pricing.http`. |
| 7 | All prior tasks complete. | Updated `scripts/test-db-seed.ts`, `README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts`; `07-…md`. |

## Exit Criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; ≥5 new pricing spec files green plus the updated `publish-product.use-case.spec.ts`.
- [ ] `yarn test:e2e` passes; `test/pricing.e2e-spec.ts` green; the publish-no-price hard-fail covered.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev && yarn test:seed` boots clean and seeds USD prices for both seeded variants.
- [ ] Every request in `http/pricing.http` executes end-to-end.
- [ ] `GET /api/catalog/variants/:variantId/price?currency=USD` returns the seeded Price.
- [ ] At-most-one-`validTo IS NULL`-per-`(variantId, currency)` invariant verified by the concurrency test.
- [ ] Per-task docs present under `docs/implementation/epic-03-pricing-price-and-tax-category/`.
- [ ] `README.md` API / Environment sections updated; `CLAUDE.md` catalog section updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
