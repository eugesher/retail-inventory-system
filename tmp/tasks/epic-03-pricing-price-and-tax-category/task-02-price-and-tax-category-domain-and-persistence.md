---
epic: epic-03
task_number: 2
title: Price + TaxCategory domain, persistence, repository, and migration
depends_on: [1]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/02-price-domain-and-append-only-history.md
adr_deliverable: docs/adr/026-price-append-only-ledger-and-tax-category.md
---

# Task 02 — Price + TaxCategory domain, persistence, repository, and migration

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-004** (domain is framework-free — no `@nestjs/*`, no
`typeorm`, no `class-validator` on the model), **ADR-005 / ADR-019** (extend
`BaseEntity`; `SnakeNamingStrategy`; hand-authored migration with working
`up`/`down`; `synchronize` stays off), **ADR-017** (the application-port layer
returns domain types only — no TypeORM `Repository`/`EntityManager` leak),
**ADR-025** (the `DomainException` + typed-code pattern, and the
`variantId`-as-backbone / repository-level-uniqueness conventions), and
**ADR-003** (you are authoring **ADR-026**).

## Goal

Give the pricing module its write/read state: the `Price` domain model (a
currency-scoped, time-bounded, append-only-for-history ledger entry) and the
`TaxCategory` domain model (a classification label), their TypeORM entities +
mappers, the `IPricingRepositoryPort` + `PricingTypeormRepository` adapter, and
one migration that creates `price`, creates `tax_category`, and adds the nullable
`product_variant.tax_category_id` FK column. Record **ADR-026** for the
append-only ledger and the at-most-one-open-row invariant.

## Entry state assumed

- task-01 carryover present. The `pricing` module skeleton exists with empty
  barrels; `pricing.module.ts` is a minimal `@Module({})`; `index.ts` exports
  `PricingModule` and `export const pricingEntities = [] as const;`;
  `app.module.ts` already spreads `pricingEntities` into
  `DatabaseModule.forRoot([...catalogEntities, ...pricingEntities])`.
- `PermissionCodeEnum.PRICING_WRITE` exists and is seeded.
- The `product_variant` table (from the catalog capability) exists with a BIGINT
  UNSIGNED `id` PK and no `tax_category_id` column yet. The latest migration is
  `…-CreateCatalogTables`.
- The catalog domain shows the patterns to mirror: `Product`/`ProductVariant`
  models, `OptionValues`/`Dimensions` value objects, `CatalogDomainException` +
  `CatalogErrorCodeEnum`, `ICatalogRepositoryPort` (domain-typed, local
  pagination interfaces), and `CatalogTypeormRepository` (its `save` re-reads the
  saved graph so generated ids come back concrete).

## Scope

**In**
- `pricing/domain/`: `Price` model + `TaxCategory` model + `PricingDomainException`
  + `PricingErrorCodeEnum`; their `domain/spec/*.spec.ts`.
- `pricing/application/ports/`: `IPricingRepositoryPort` (+ `PRICING_REPOSITORY`
  symbol) returning domain types only.
- `pricing/infrastructure/persistence/`: `PriceEntity`, `TaxCategoryEntity`,
  `PriceMapper`, `TaxCategoryMapper`, `PricingTypeormRepository`; populate
  `pricingEntities`.
- Wire `DatabaseModule.forFeature([PriceEntity, TaxCategoryEntity])` +
  `PRICING_REPOSITORY → PricingTypeormRepository` in `pricing.module.ts`.
- One migration: `price`, `tax_category`, `product_variant.tax_category_id`.
- ADR-026 + docs `02` and the domain/persistence half of `03`.

**Out**
- Use cases, events, routing keys, controller handlers (task-03 / 04).
- The `attachTaxCategoryToVariant` / variant-tax-header read repository methods
  and their use case (task-04).
- The Select Applicable *resolution* (sort/tiebreak/pick) — that lives in the
  use case (task-03); this task supplies only the `findInEffect` candidate query.
- The publish hard-fail (task-05); gateway, `.http`, seed rows (task-06 / 07 / 08).

## Domain model specifics

**`Price`** (a single ledger row; framework-free):
- Fields: `id: number | null`, `variantId: number` (opaque — **never** import the
  catalog `ProductVariant`; the link is the FK in persistence per the forbidden-
  import rule), `currency: string`, `amountMinor: number`, `validFrom: Date`,
  `validTo: Date | null`, `priority: number`.
- Two construction paths:
  - `Price.set({ variantId, currency, amountMinor, validFrom?, validTo?, priority? })`
    — the standard write path. `validFrom` defaults to "now". **Rejects a
    `validFrom` strictly before now** (`PRICE_VALID_FROM_IN_PAST`) — set/schedule
    only open intervals at or after now; historical rows are never authored
    through this path.
  - `Price.reconstitute({ id, variantId, currency, amountMinor, validFrom, validTo, priority })`
    — loads a row from persistence (any `validFrom`, including the past) and is
    also how the repository materializes a closed predecessor. No "past" guard.
- Invariants (raise `PricingDomainException` with a typed code):
  - `amountMinor` is an integer `≥ 0` (`PRICE_AMOUNT_INVALID`).
  - `currency` matches `^[A-Z]{3}$` (ISO-4217 shape only — no rate/lookup)
    (`PRICE_CURRENCY_INVALID`).
  - when `validTo` is set, `validFrom < validTo` (`PRICE_INTERVAL_INVALID`).
  - `priority` is an integer (default `0`).
- A `close(at: Date): Price` (or equivalent) helper that returns the row with
  `validTo = at` — the **only** permitted mutation of an existing row. `amountMinor`,
  `currency`, `variantId`, `priority` are immutable once created; never expose a
  setter for them. (Append-only-for-history: a price *change* is a new row plus a
  close of the predecessor, never an in-place value edit.)

**`TaxCategory`** (framework-free):
- Fields: `id: number | null`, `code: string`, `name: string`, `description: string | null`.
- `code` is `UPPER_SNAKE_CASE` — matches `^[A-Z][A-Z0-9_]*$` (`TAX_CATEGORY_CODE_INVALID`);
  `name` non-empty (`TAX_CATEGORY_NAME_REQUIRED`).
- Global `code` uniqueness is a **repository-level** invariant (a UNIQUE
  constraint + a use-case pre-check), not enforced in the model (mirror the
  catalog `slug`/`sku` convention, ADR-025).

**`PricingErrorCodeEnum` + `PricingDomainException`** — mirror
`CatalogErrorCodeEnum`/`CatalogDomainException`. Stable, greppable codes the
presentation layer maps to HTTP later (task-03/04 add a pricing RPC exception
filter, or reuse the catalog one's pattern). Seed the enum with at least:
`PRICE_AMOUNT_INVALID`, `PRICE_CURRENCY_INVALID`, `PRICE_INTERVAL_INVALID`,
`PRICE_VALID_FROM_IN_PAST`, `TAX_CATEGORY_CODE_INVALID`,
`TAX_CATEGORY_NAME_REQUIRED`, `TAX_CATEGORY_CODE_TAKEN`,
`TAX_CATEGORY_NOT_FOUND`, `VARIANT_NOT_FOUND` (used by task-04's attach).

## Repository port

`IPricingRepositoryPort` (+ `export const PRICING_REPOSITORY = Symbol('PRICING_REPOSITORY')`)
— domain types only, local pagination/parameter interfaces if needed (no
`typeorm` import, ADR-017):

```ts
findOpenPrice(variantId: number, currency: string): Promise<Price | null>;
// Atomic: if predecessorToClose is non-null, set its valid_to in the SAME
// transaction as the insert of newPrice; re-read and return the inserted row
// with its concrete id. The DB-level open-scope unique index is the backstop.
appendPrice(newPrice: Price, predecessorToClose: Price | null): Promise<Price>;
// All rows whose [validFrom, validTo) contains asOf for (variantId, currency).
// Coarse filter only — the priority/recency resolution lives in the use case.
findInEffect(variantId: number, currency: string, asOf: Date): Promise<Price[]>;
createTaxCategory(taxCategory: TaxCategory): Promise<TaxCategory>;
listTaxCategories(): Promise<TaxCategory[]>;
findTaxCategoryByCode(code: string): Promise<TaxCategory | null>;
```

(task-04 extends this port with the variant-tax-attach methods.)

## Persistence specifics

`PriceEntity` / `TaxCategoryEntity` extend `BaseEntity` (auto-increment integer
`id` in TypeORM metadata, `createdAt`/`updatedAt`/`deletedAt`). `deletedAt` stays
**inert** on both tables (pricing never soft-deletes — Price is append-only,
TaxCategory is a static label set), exactly as the catalog tables leave it inert.
Fields are camelCase; `SnakeNamingStrategy` maps to snake_case columns.

`PricingTypeormRepository` is the only file allowed to use `InjectRepository`;
its `appendPrice` runs the close-predecessor UPDATE + the insert inside one
TypeORM transaction (use the repository `manager.transaction(...)`), then re-reads
the inserted row so the assigned id is concrete — the same "re-read the saved
graph" idiom `CatalogTypeormRepository.save` uses.

### Migration (`yarn migration:create`)

One migration with a working `up`/`down` (`synchronize` stays off). Concrete
shape (BIGINT UNSIGNED `variant_id` matches `product_variant.id`):

```sql
-- up
CREATE TABLE tax_category (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(50)  NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description VARCHAR(1000) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  TIMESTAMP NULL,
  CONSTRAINT UC_TAX_CATEGORY_CODE UNIQUE (code)
);

CREATE TABLE price (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  variant_id     BIGINT UNSIGNED NOT NULL,
  currency       CHAR(3) NOT NULL,
  amount_minor   BIGINT NOT NULL,
  valid_from     TIMESTAMP NOT NULL,
  valid_to       TIMESTAMP NULL,
  priority       INT NOT NULL DEFAULT 0,
  -- DB-level "at most one open row per (variant_id, currency)" backstop:
  -- a STORED generated column that is non-NULL only while valid_to IS NULL.
  -- MySQL allows many NULLs under a UNIQUE index, so closed rows never collide.
  open_scope_key VARCHAR(32) GENERATED ALWAYS AS
                   (CASE WHEN valid_to IS NULL THEN CONCAT(variant_id, ':', currency) ELSE NULL END) STORED,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMP NULL,
  CONSTRAINT UC_PRICE_OPEN_SCOPE UNIQUE (open_scope_key),
  CONSTRAINT FK_PRICE_VARIANT FOREIGN KEY (variant_id)
    REFERENCES product_variant (id) ON DELETE RESTRICT
);
CREATE INDEX IDX_PRICE_RESOLVE ON price (variant_id, currency, valid_from DESC);

ALTER TABLE product_variant
  ADD COLUMN tax_category_id INT UNSIGNED NULL,
  ADD CONSTRAINT FK_PRODUCT_VARIANT_TAX_CATEGORY FOREIGN KEY (tax_category_id)
    REFERENCES tax_category (id) ON DELETE SET NULL;
```

`down` reverses in dependency order: drop the `product_variant` FK + column,
then `DROP TABLE price`, then `DROP TABLE tax_category`.

- Do **not** map `open_scope_key` in `PriceEntity` — it is a DB-internal backstop;
  with `synchronize` off TypeORM never touches it, and inserts that omit it let
  MySQL compute it.
- The app-level guarantee (`appendPrice` closes the predecessor before inserting)
  is the primary mechanism; `UC_PRICE_OPEN_SCOPE` is the backstop the concurrency
  test (task-06) exercises.

## Files to add

- `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts`
- `apps/catalog-microservice/src/modules/pricing/domain/tax-category.model.ts`
- `apps/catalog-microservice/src/modules/pricing/domain/pricing.exception.ts`
  (`PricingDomainException` + `PricingErrorCodeEnum`)
- `apps/catalog-microservice/src/modules/pricing/domain/spec/price.model.spec.ts`
- `apps/catalog-microservice/src/modules/pricing/domain/spec/tax-category.model.spec.ts`
- `apps/catalog-microservice/src/modules/pricing/application/ports/pricing.repository.port.ts`
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/price.entity.ts`
- `.../persistence/tax-category.entity.ts`
- `.../persistence/price.mapper.ts`
- `.../persistence/tax-category.mapper.ts`
- `.../persistence/pricing-typeorm.repository.ts`
- `.../persistence/spec/pricing-typeorm.repository.spec.ts` (optional but
  recommended — mirror `catalog-typeorm.repository.spec.ts`)
- `migrations/<timestamp>-CreatePricingTables.ts`
- `docs/adr/026-price-append-only-ledger-and-tax-category.md`
- `docs/implementation/03-pricing-price-and-tax-category/02-price-domain-and-append-only-history.md`
- `docs/implementation/03-pricing-price-and-tax-category/03-tax-category-and-variant-attachment.md`
  (domain/persistence half — task-04 completes it)

## Files to modify

- `apps/catalog-microservice/src/modules/pricing/domain/index.ts`,
  `application/ports/index.ts`, `infrastructure/persistence/index.ts` — barrel
  the new exports.
- `apps/catalog-microservice/src/modules/pricing/index.ts` — set
  `pricingEntities = [PriceEntity, TaxCategoryEntity]`.
- `apps/catalog-microservice/src/modules/pricing/pricing.module.ts` — import
  `DatabaseModule.forFeature([PriceEntity, TaxCategoryEntity])`; provide
  `PricingTypeormRepository` + `{ provide: PRICING_REPOSITORY, useExisting:
  PricingTypeormRepository }`.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `price.model.spec.ts` — the append-only invariant (`Price.set` rejects a
    `validFrom` strictly before now; `Price.reconstitute` accepts a past
    `validFrom`); `validFrom < validTo` when `validTo` is set; `amountMinor ≥ 0`
    integer; `currency` 3-char ISO shape; `close(at)` produces a closed row and
    leaves value fields untouched.
  - `tax-category.model.spec.ts` — `code` is `UPPER_SNAKE_CASE`; uniqueness is
    asserted via a repository test double (the model does not self-enforce it).
- **Repository spec** (optional) — `appendPrice` closes the open predecessor and
  inserts atomically; `findInEffect` returns interval-containing rows.
- **Migration** — `yarn migration:run` applies cleanly on top of the catalog
  tables; `yarn migration:revert` removes the column + both tables cleanly.
  Re-running `migration:run` after a revert reapplies without error.
- No seed change in this task (price/tax seed rows land in task-08).

## Doc deliverable

`02-price-domain-and-append-only-history.md` — outline:
- **Append-only-for-history** — why a Price is never value-edited in place; a
  change = new row + close predecessor; the closed/open `[validFrom, validTo)`
  interval ledger; how this satisfies the always-audit "every Price change" rule.
- **The `(variantId, currency)` scope** — the only scope axis this capability has;
  why location/channel/customer-group scope is explicitly out (a future
  `priceScope` extension lifts it).
- **At-most-one-open invariant** — the app-level close-in-transaction primary
  mechanism + the `open_scope_key` generated-column UNIQUE backstop; why MySQL
  has no native partial unique index and how the generated column emulates it.
- **`variantId` as an opaque link** — pricing domain never imports the catalog
  domain; the FK in persistence is the only coupling.

`03-tax-category-and-variant-attachment.md` (domain/persistence half) —
classification-only semantics; rate computation explicitly deferred to a future
tax-computation capability (no rates, no jurisdictions here); the
`tax_category` table + the nullable `product_variant.tax_category_id` FK
(`ON DELETE SET NULL`). Leave a clearly marked section for task-04 to complete
(the attach use case + endpoint).

## ADR deliverable

`docs/adr/026-price-append-only-ledger-and-tax-category.md` (Nygard hybrid:
Status, Context, Decision, Alternatives Considered, Consequences; 3-digit padded;
allocate the number at first commit — if `026` is taken, take the next free
number and record it in the carryover). Decision content:
- `Price` is an append-only-for-history, currency-scoped, time-bounded ledger
  keyed on the opaque `variantId`; a change is a new row + a close of the
  predecessor's `validTo`, never an in-place value edit.
- The `(variantId, currency)` scope is the only axis; at most one open
  (`validTo IS NULL`) row per scope — app-level close-in-transaction + a DB
  generated-column UNIQUE backstop.
- Select Applicable resolution = highest `priority`, then latest `validFrom`,
  over the interval-containing rows (the algorithm itself is realized in the
  use case — task-03 — and cross-referenced here).
- `TaxCategory` is a classification label only; rates/jurisdictions/conversion
  are out (deferred to a future tax-computation capability).
- Alternatives: in-place mutable price (rejected — loses audit/history);
  location/channel scope now (rejected — unmet threshold); a separate pricing
  microservice (rejected — colocates with catalog, shares `catalog_queue`).

## Carryover to read

`carryover-01.md`.

## Carryover to produce

Write `carryover-02.md`. Capture: the `Price`/`TaxCategory` model APIs (factory
names, invariants, the `close` helper); `PricingErrorCodeEnum` member names;
`IPricingRepositoryPort` method signatures + the `PRICING_REPOSITORY` symbol; the
entity/table names + the `open_scope_key` backstop; the migration filename +
that `tax_category_id` now exists on `product_variant`; the ADR number actually
allocated; that `pricingEntities` is now `[PriceEntity, TaxCategoryEntity]`. Note
the gaps owned by later tasks (use cases/events/routing keys → task-03; tax use
cases + variant attach → task-04; publish hard-fail → task-05). List the verify
commands (`yarn lint`, `yarn test:unit`, `yarn migration:run` + `revert`,
`yarn build`, the self-containment grep).

## Exit criteria

- [ ] `Price` + `TaxCategory` models with their invariants and specs exist and
      are green under `yarn test:unit`.
- [ ] `IPricingRepositoryPort` returns domain types only (no `typeorm` import);
      `PricingTypeormRepository` implements it; `appendPrice` is atomic.
- [ ] The migration applies and reverts cleanly on top of the catalog schema;
      `price`, `tax_category`, and `product_variant.tax_category_id` exist with
      the documented FKs, the resolve index, and the `open_scope_key` UNIQUE
      backstop.
- [ ] `pricingEntities` is populated and the service boots
      (`yarn start:dev` + `docker compose up -d` + `yarn migration:run`).
- [ ] `yarn lint` passes (`--max-warnings 0`); the pricing domain imports nothing
      from the catalog module.
- [ ] `yarn test:unit` passes; `yarn test:e2e` passes (unchanged behavior).
- [ ] ADR-026 + docs `02` and the domain/persistence half of `03` are written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-02.md` is written.
