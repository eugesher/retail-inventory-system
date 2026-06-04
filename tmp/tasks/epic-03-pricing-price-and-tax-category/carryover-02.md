# Carryover 02 — Price + TaxCategory domain, persistence, repository, migration

State handed forward from task-02 to task-03 (and beyond). Read this before
touching the pricing module. (Read `carryover-01.md` first.)

## Entry state for task-03

The pricing module now owns its write/read **state**. On disk under
`apps/catalog-microservice/src/modules/pricing/`:

- **`domain/`** — framework-free `Price` + `TaxCategory` models, the exception.
- **`application/ports/`** — `IPricingRepositoryPort` + `PRICING_REPOSITORY` symbol.
- **`infrastructure/persistence/`** — `PriceEntity` / `TaxCategoryEntity`, their
  mappers, `PricingTypeormRepository`.
- **`pricing.module.ts`** — imports `DatabaseModule.forFeature([PriceEntity,
  TaxCategoryEntity])`; provides `PricingTypeormRepository` +
  `{ provide: PRICING_REPOSITORY, useExisting: PricingTypeormRepository }`. Still
  **no** controller, **no** events publisher, **no** `MicroserviceClientCatalogModule`
  import (those arrive with the use cases/events — task-03/04).
- **`index.ts`** (module root) — `pricingEntities = [PriceEntity, TaxCategoryEntity]`
  (was `[]`). `app/app.module.ts` is **unchanged** — it already spreads
  `pricingEntities` into `DatabaseModule.forRoot([...catalogEntities, ...pricingEntities])`.

The `price` + `tax_category` tables exist in `retail_db`, and `product_variant`
has a nullable `tax_category_id` FK. The catalog service boots clean (e2e green).

### `Price` model API (`domain/price.model.ts`)

- Extends `Entity<number | null>` (id null pre-persistence, concrete after load).
- Fields: `id`, `variantId` (opaque number — **never** import catalog
  `ProductVariant`), `currency`, `amountMinor`, `validFrom: Date`,
  `validTo: Date | null`, `priority`.
- `Price.set(input: ISetPriceInput, now: Date = new Date()): Price` — standard
  write path. `ISetPriceInput = { variantId, currency, amountMinor, validFrom?,
  validTo?, priority? }`. `validFrom` defaults to `now`; **rejects a `validFrom`
  strictly before `now`** (`PRICE_VALID_FROM_IN_PAST`). `validTo` defaults null,
  `priority` defaults 0. `now` is injectable for deterministic specs.
- `Price.reconstitute(props: IPriceProps): Price` — load path, **any** validFrom
  (no past guard). `IPriceProps = { id, variantId, currency, amountMinor,
  validFrom, validTo, priority }` (all required).
- Getters: `variantId`, `currency`, `amountMinor`, `validFrom`, `validTo`,
  `priority`, plus `isOpen(): boolean` (`validTo === null`).
- **`close(at: Date): Price`** — the ONLY mutation; returns a NEW `Price` with the
  same value fields and `validTo = at`. Value fields are immutable (no setters).
  Closing at-or-before `validFrom` throws `PRICE_INTERVAL_INVALID`.
- Invariants → `PricingDomainException`: `amountMinor` integer ≥ 0
  (`PRICE_AMOUNT_INVALID`); `currency` `^[A-Z]{3}$` (`PRICE_CURRENCY_INVALID`);
  `validFrom < validTo` when `validTo` set (`PRICE_INTERVAL_INVALID`); `priority`
  integer (`PRICE_PRIORITY_INVALID`).

### `TaxCategory` model API (`domain/tax-category.model.ts`)

- Extends `Entity<number | null>`. Fields: `id`, `code`, `name`,
  `description: string | null`.
- `TaxCategory.create({ code, name, description? }): TaxCategory` (id null);
  `TaxCategory.reconstitute({ id, code, name, description? }): TaxCategory`.
- Getters: `code`, `name`, `description`.
- Invariants: `code` `^[A-Z][A-Z0-9_]*$` (`TAX_CATEGORY_CODE_INVALID`); `name`
  non-empty (`TAX_CATEGORY_NAME_REQUIRED`). **`code` uniqueness is NOT enforced
  in the model** — repository-level (use-case pre-check + UNIQUE constraint).

### `PricingErrorCodeEnum` + `PricingDomainException` (`domain/pricing.exception.ts`)

Member names → string values (`PRICING_*` prefix, greppable):
`PRICE_AMOUNT_INVALID`, `PRICE_CURRENCY_INVALID`, `PRICE_INTERVAL_INVALID`,
`PRICE_VALID_FROM_IN_PAST`, `PRICE_PRIORITY_INVALID` (added — not in the original
seed list; covers the non-integer-priority invariant), `TAX_CATEGORY_CODE_INVALID`,
`TAX_CATEGORY_NAME_REQUIRED`, `TAX_CATEGORY_CODE_TAKEN`, `TAX_CATEGORY_NOT_FOUND`,
`VARIANT_NOT_FOUND`. `PricingDomainException extends DomainException` with a typed
`code` (mirrors `CatalogDomainException`). The typed `code` is a **property**, not
in the message — assert `err.code`, don't string-match the message.

### `IPricingRepositoryPort` (`application/ports/pricing.repository.port.ts`)

```ts
export const PRICING_REPOSITORY = Symbol('PRICING_REPOSITORY');

findOpenPrice(variantId: number, currency: string): Promise<Price | null>;
appendPrice(newPrice: Price, predecessorToClose: Price | null): Promise<Price>;
findInEffect(variantId: number, currency: string, asOf: Date): Promise<Price[]>;
createTaxCategory(taxCategory: TaxCategory): Promise<TaxCategory>;
listTaxCategories(): Promise<TaxCategory[]>;
findTaxCategoryByCode(code: string): Promise<TaxCategory | null>;
```

Domain types only (no `typeorm` import). `appendPrice`: the caller passes the
**already-closed** predecessor (`open.close(at)`); the repo UPDATEs its `valid_to`
and INSERTs the successor in **one** `manager.transaction(...)`, then re-reads by
id for the concrete generated id. `findInEffect` is a **coarse** candidate query
(`valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf)`, ordered
`priority DESC, validFrom DESC`) — the **Select Applicable resolution
(sort/tiebreak/pick) is task-03's use case**, not the repo. (task-04 extends this
port with the variant-tax-attach methods.)

### Persistence + migration facts

- Entities/tables: `PriceEntity` → `price`, `TaxCategoryEntity` → `tax_category`.
  Both extend `BaseEntity`; `deletedAt` is **inert** (pricing never soft-deletes).
- `PriceEntity` maps `variantId` (BIGINT scalar — **no `@ManyToOne`**), `currency`
  (char(3)), `amountMinor` (BIGINT), `validFrom`/`validTo` (timestamp), `priority`
  (int). It does **NOT** map `open_scope_key` (DB-internal backstop).
- **mysql2 returns non-PK BIGINT as strings** — `PriceMapper.toDomain` coerces
  `variant_id` / `amount_minor` with `Number(...)`. The BIGINT PK comes back a
  number. (A spec asserts the coercion.)
- Migration: **`migrations/1780546069117-CreatePricingTables.ts`** (class
  `CreatePricingTables1780546069117`). Creates `tax_category`, `price`
  (with `open_scope_key VARCHAR(32) GENERATED ALWAYS AS (CASE WHEN valid_to IS
  NULL THEN CONCAT(variant_id, ':', currency) ELSE NULL END) STORED`,
  `UC_PRICE_OPEN_SCOPE UNIQUE (open_scope_key)`, `IDX_PRICE_RESOLVE
  (variant_id, currency, valid_from DESC)`, `FK_PRICE_VARIANT … ON DELETE
  RESTRICT`), and `ALTER TABLE product_variant ADD COLUMN tax_category_id INT
  UNSIGNED NULL` + `FK_PRODUCT_VARIANT_TAX_CATEGORY … ON DELETE SET NULL`.
  `down` reverses in dependency order. **Verified live:** run/revert/run is clean;
  a second open row for one `(variant_id, currency)` scope fails on
  `UC_PRICE_OPEN_SCOPE`; closed rows (NULL key) and cross-currency open rows
  coexist.

### Decisions & deviations

- **ADR number allocated: ADR-026** (`docs/adr/026-price-append-only-ledger-and-tax-category.md`,
  Accepted 2026-06-04). Added to `docs/adr/index.md`.
- **`PRICE_PRIORITY_INVALID` added** to `PricingErrorCodeEnum` beyond the task's
  seed list — every invariant raises a typed code (the non-integer-priority case
  had none otherwise).
- **`Price.set` takes an injectable `now` second arg** (`now = new Date()`) for
  deterministic specs — keep it when the use case calls `Price.set`.
- `pricingEntities` stayed in the **module-root `index.ts`** (importing the
  entities from `./infrastructure/persistence`) rather than relocating to mirror
  catalog's `infrastructure/persistence/index.ts` — either was allowed by
  carryover-01; the module-root location keeps `app.module.ts` untouched.

## Known gaps / deferrals (each owned by a later task)

- **Price write use case + Select Applicable resolution + events + routing keys**
  → task-03. The repo gives the candidate set (`findInEffect`) and the atomic
  `appendPrice`; the **sort/tiebreak/pick policy (highest priority, then latest
  validFrom)** is the use case's.
- **Tax-category use cases (create/list) + variant attach** (`attachTaxCategoryToVariant`
  + variant-tax-header read method on the port + the attach use case) → task-04.
  The `tax_category_id` FK column already exists.
- **Publish hard-fail** (publish blocks a price-less product) → task-05.
- **Gateway pricing endpoints** → task-06; **`http/pricing.http`** → task-07;
  **price/tax seed rows + finalization** → task-08. No seed change in task-02.

## How to verify (all run green at end of task-02)

- `yarn lint` — exit 0 (`--max-warnings 0`). No boundary violations; the pricing
  domain imports nothing from the catalog module.
- `yarn test:unit` — **435 tests / 60 suites** pass (42 new pricing tests:
  `price.model.spec.ts`, `tax-category.model.spec.ts`,
  `pricing-typeorm.repository.spec.ts`).
- `yarn build` — exit 0.
- `yarn migration:run` then `yarn migration:revert` then `yarn migration:run` —
  applies, reverts (drops the FK+column then both tables), reapplies, all clean.
- `yarn test:e2e` — **75 tests / 6 suites** pass on a fresh infra reload + migrate
  (incl. the pricing migration) + seed (unchanged behavior).
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`
  → no orchestration references.
