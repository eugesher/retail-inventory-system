---
epic: epic-03
task_number: 2
title: Add Price + TaxCategory domain models, persistence entities, repository ports/adapters, and migration; attach tax_category_id to product_variant
depends_on: [task-01]
doc_deliverable:
  - docs/implementation/epic-03-pricing-price-and-tax-category/02-price-domain-and-append-only-history.md
  - docs/implementation/epic-03-pricing-price-and-tax-category/03-tax-category-and-variant-attachment.md
---

# Task 02 — Add `Price` + `TaxCategory` domain + persistence + repositories

## Goal

Fill the empty `pricing/` skeleton from task-01 with the two domain aggregates this epic owns: `Price` (the time-bounded, append-only money record) and `TaxCategory` (a small classification table). Create their TypeORM entities, mappers, and repository ports + adapters. Land a single migration that creates both tables and adds the nullable `tax_category_id` column on `product_variant` from epic-02. **No use cases or controllers in this task** — those are task-03 (use cases) and task-05 (api-gateway). The exit state is "schema + domain + ports are in place; the read/write methods do nothing yet beyond passing the model in and out of TypeORM."

The two domain models in this task encode the epic's two hardest invariants: **append-only-for-history** on Price (no UPDATE on a row whose `validFrom ≤ now`) and **classification-only** on TaxCategory (no rate, no jurisdiction, no computation). Get both right at the model level; everything downstream rides on that.

## Entry state assumed

Task-01 complete. Specifically:

- `apps/catalog-microservice/src/modules/pricing/` exists with the empty per-module hexagonal tree; `PricingModule` is imported into `AppModule`.
- `libs/messaging/routing-keys.constants.ts` lists `CATALOG_PRICE_CHANGED` and `CATALOG_PRICE_SCHEDULED` (but no emitter calls these yet).
- `libs/cache/cache-keys.ts` lists the `catalogPrice*` builders (no caller yet).
- `apps/catalog-microservice/src/modules/catalog/` is fully populated from epic-02: `product.model.ts`, `product-variant.model.ts`, their entities, mappers, repositories, and the `Register Product` / `Add Variant` / `Publish Product` / `Archive Product` use cases.
- The latest migration on disk is the one introduced by epic-02 task-02 (`CreateProductAndProductVariantTables`).
- `apps/catalog-microservice/src/app/app.module.ts` calls `DatabaseModule.forRoot([ProductEntity, ProductVariantEntity])`. This task extends the entity list.

## Scope

**In:**

- Domain models under `…/modules/pricing/domain/`:
  - `price.model.ts` — the `Price` aggregate; encodes the append-only-for-history invariant.
  - `tax-category.model.ts` — the `TaxCategory` value-style aggregate; encodes the `UPPER_SNAKE_CASE` code rule.
  - `currency-code.ts` — a thin ISO-4217 3-char shape guard (no full registry — open question; see §"Currency validation depth" below).
  - `money.ts` — an in-domain helper that pairs `{ currency: string; amountMinor: number }`. Distinct from the entity's storage shape; used internally by `Price` and exposed to use cases so the rest of the codebase does not assemble currency+amount pairs by hand.
- TypeORM entities under `…/modules/pricing/infrastructure/persistence/`:
  - `price.entity.ts` — table `price`.
  - `tax-category.entity.ts` — table `tax_category`.
  - `price.mapper.ts` and `tax-category.mapper.ts`.
- Repository ports under `…/modules/pricing/application/ports/`:
  - `price.repository.port.ts` — interface plus an injection token (mirror the convention used by the existing `catalog` module).
  - `tax-category.repository.port.ts` — same.
- Repository TypeORM adapters under `…/modules/pricing/infrastructure/persistence/`:
  - `price.typeorm.repository.ts` — implements the port; methods listed under §"Repository port surface".
  - `tax-category.typeorm.repository.ts` — implements the port.
- A clock port: `…/modules/pricing/application/ports/clock.port.ts` — a thin `now(): Date` interface (and a system adapter under `infrastructure/`). Use cases that compare `validFrom` / `validTo` to "now" must inject this port instead of calling `new Date()` directly so the future task-03 unit tests can fake time. **Crosscheck**: if the existing `catalog/` module already exposes a clock port (look under `apps/catalog-microservice/src/modules/catalog/application/ports/`), reuse it rather than defining a second one — the cross-module-import ban from task-01 forbids importing across `pricing/` ↔ `catalog/` at the domain layer, but a shared port may belong in `libs/common/` or `libs/ddd/`. **Decision**: if no port exists yet in the catalog module, place `clock.port.ts` inside `pricing/application/ports/`; do not promote it to `libs/` in this task — premature shared abstraction. If a clock port already exists in `libs/common/` or `libs/ddd/`, reuse it.
- Modify `apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts` to add a nullable `taxCategoryId: number | null` field. Modify its entity (`product-variant.entity.ts`) to add the `tax_category_id` column. Modify the mapper. **Do not** make `ProductVariant` aware of the `TaxCategory` aggregate — the field is opaque (a number), exactly mirroring the cross-module ban from task-01. The reasoning belongs in doc 03.
- Wire the new entities into `PricingModule`: replace the empty `TypeOrmModule.forFeature([])` from task-01 with `TypeOrmModule.forFeature([PriceEntity, TaxCategoryEntity])`. Register the repositories as providers behind the port tokens.
- Wire the entities into `app.module.ts`'s `DatabaseModule.forRoot([…])` entity list.
- A single new TypeORM migration: `CreatePriceAndTaxCategoryTables` (filename `<timestamp>-CreatePriceAndTaxCategoryTables.ts`). Schema details under §"Migration".
- Unit specs for the two domain models (see §"Tests").
- Doc deliverables `02-price-domain-and-append-only-history.md` and `03-tax-category-and-variant-attachment.md`.

**Out:**

- `SetPriceUseCase`, `SchedulePriceUseCase`, `SelectApplicablePriceUseCase` — task-03.
- Event payloads / publishers — task-03.
- Cache-aside on the read path — explicitly out of scope this epic.
- Hooking `Publish Product` into the new repository — task-04 (it injects `SelectApplicablePriceUseCase`, not the repo directly).
- Api-gateway DTOs and pipes — task-05.
- Seed data — task-07.

## `Price` domain model

`Price` is a single immutable record describing what the variant cost in a given currency during a given closed-open interval. The interval is `[validFrom, validTo)` when `validTo` is set, or `[validFrom, ∞)` when `validTo IS NULL`. The aggregate carries no setter for `validTo` after construction; the only legal way to "end" a Price is to write a new row with `validFrom = old.validTo`.

**Fields (all readonly after construction):**

- `id: number | null` — null for a not-yet-persisted Price; set by TypeORM after insert.
- `variantId: number` — FK to `product_variant.id`. Opaque in the domain (no relation object).
- `currency: string` — ISO-4217 3-char uppercase. See §"Currency validation depth" for the validation rule applied here.
- `amountMinor: number` — non-negative integer; minor-unit (cents). Stored as `BIGINT` in MySQL; in TypeScript expressed as `number` (safe up to ~9 quadrillion minor units, well within float-64 integer precision for any realistic retail price).
- `validFrom: Date` — UTC instant. Must be less than `validTo` if `validTo` is set.
- `validTo: Date | null` — UTC instant or null.
- `priority: number` — non-negative integer; default `0`. Tiebreaker for the resolution algorithm in task-03 (`Select Applicable Price`).
- `createdAt: Date`, `updatedAt: Date` — TypeORM-managed.

**Constructor invariants (raise `DomainError` on violation):**

- `currency` matches `/^[A-Z]{3}$/` (the model uppercases on input before checking, so callers can pass `"usd"`).
- `amountMinor >= 0`. Negative pricing is reserved for refunds / credit notes (Exclusions Register, `epic-15`).
- If `validTo` is provided, `validFrom < validTo`.
- `priority >= 0`.

**Methods:**

- `static create({ variantId, currency, amountMinor, validFrom, validTo, priority }, clock: ClockPort): Price` — constructs a Price for the "Set Price" or "Schedule Price" path. Asserts `validFrom >= clock.now()` for live writes (this is the "no historical edits via the standard path" rule from the epic). Use cases that need to construct a Price with `validFrom < clock.now()` must call `Price.importHistorical(…)` instead — see below.
- `static importHistorical(fields): Price` — bypasses the `validFrom >= now` check; reserved for future seed / data-migration paths. Not called by any use case in this epic; exists only to make the "historical" code path explicit per the epic's domain spec list.
- `closeAt(instant: Date, clock: ClockPort): Price` — returns a NEW Price (same `id`, `validTo = instant`) and asserts the row is still open. Used by `SetPriceUseCase` in task-03 to close the predecessor's `validTo`. The return type is `Price`, not `void` — the repository writes the returned object. **The aggregate is not mutated in place.** This is the literal implementation of the "append-only-for-history" rule: the only mutation a Price ever sees after construction is `validTo` going from `null` to a closing instant — and even that is modeled as "return a fresh instance with the closing value set." The TypeORM adapter implements this as an `UPDATE` on the `valid_to` column (closing the open interval is the one case where in-place UPDATE is allowed; closing a Price is the explicit predecessor-link, not a content change). The doc deliverable spells this distinction out.

**Important:** `Price.closeAt` is the **only** place in the model that produces a row with the same `id`. Every other write produces a new row with no `id`. This is the API a downstream reviewer can grep for to confirm append-only.

## `TaxCategory` domain model

`TaxCategory` is a small, static, mostly-readonly aggregate. The system uses it as a classification label only — nothing in this epic computes a tax based on it. The actual rates, jurisdictions, and computation engine are deferred to `epic-15`.

**Fields:**

- `id: number | null`.
- `code: string` — `UPPER_SNAKE_CASE` ASCII, length 1–50. Unique per the DB constraint.
- `name: string` — human-readable label, length 1–100.
- `description: string` — optional long-form text, length 0–500.

**Constructor invariants:**

- `code` matches `/^[A-Z][A-Z0-9_]*$/` (starts with a letter, only `A-Z`, `0-9`, `_`).
- `name` and `description` lengths within bounds.
- `code` uppercase-coerced on input (so `"reduced"` → `"REDUCED"`).

**Methods:**

- `static create({ code, name, description }): TaxCategory` — standard constructor.
- No update methods. TaxCategory is in practice append-only at the application layer (deleting a code that is referenced by `product_variant.tax_category_id` would orphan the variant; the FK uses `ON DELETE SET NULL` to handle the degenerate case gracefully).

## Currency validation depth

The epic says ISO-4217, 3-char. The minimum bar here is **format-only**: the model asserts `/^[A-Z]{3}$/`. The model does **not** carry a registry of "is `XBT` a real currency code." Reasoning:

- The walking-skeleton seed only writes `USD`; the only enforcement that matters at this stage is "the column is constrained to 3 uppercase letters."
- Storing a full ISO-4217 registry inside the domain creates a hidden contract — every new currency needs a code change. The team's stated direction (per the report cited in the epic) is to defer currency-conversion / FX to `epic-15`, which means the registry-management problem belongs there too.
- The `Order.currency` snapshot in `epic-05` will inherit whatever the resolved Price carries; if the snapshot is `XXX`, that is the catalog's mistake, not the order's.

Document the choice in `02-price-domain-and-append-only-history.md`. The doc also reserves the option to upgrade later (a TODO comment in the model that points to the doc section).

## Repository port surface

`PriceRepositoryPort` (interface):

```ts
interface PriceRepositoryPort {
  insert(price: Price): Promise<Price>;                                                  // returns the row with `id` populated
  closePredecessor(price: Price): Promise<void>;                                         // UPDATEs `valid_to` on a row whose id matches; the only allowed in-place update
  findCurrentlyOpenFor(variantId: number, currency: string): Promise<Price | null>;     // finds the row where valid_to IS NULL
  findApplicable(variantId: number, currency: string, asOf: Date): Promise<Price | null>; // resolution algorithm; task-03 owns the SQL
  findAllInEffect(variantId: number, currency: string, asOf: Date): Promise<Price[]>;   // list endpoint backing
}
```

`TaxCategoryRepositoryPort`:

```ts
interface TaxCategoryRepositoryPort {
  insert(taxCategory: TaxCategory): Promise<TaxCategory>;
  findAll(): Promise<TaxCategory[]>;
  findByCode(code: string): Promise<TaxCategory | null>;
  findById(id: number): Promise<TaxCategory | null>;
}
```

The TypeORM implementations live in `…/modules/pricing/infrastructure/persistence/`. `findApplicable` carries the resolution SQL — for this task it is allowed to be a passive `SELECT … ORDER BY priority DESC, valid_from DESC LIMIT 1`; task-03 owns the resolution semantics and may push the algorithm into a domain service. `closePredecessor` is the one method that issues an `UPDATE`; document this explicitly inline.

## Migration

`migrations/<timestamp>-CreatePriceAndTaxCategoryTables.ts`. The migration is the only one in this epic and lands here.

**Tables:**

```sql
CREATE TABLE tax_category (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tax_category_code (code)
) ENGINE=InnoDB;

CREATE TABLE price (
  id BIGINT NOT NULL AUTO_INCREMENT,
  variant_id BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL,
  valid_from TIMESTAMP NOT NULL,
  valid_to TIMESTAMP NULL,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_price_variant FOREIGN KEY (variant_id) REFERENCES product_variant(id) ON DELETE RESTRICT,
  KEY idx_price_lookup (variant_id, currency, valid_from DESC),
  CONSTRAINT chk_price_amount_nonneg CHECK (amount_minor >= 0),
  CONSTRAINT chk_price_interval CHECK (valid_to IS NULL OR valid_from < valid_to)
) ENGINE=InnoDB;
```

**Column addition on `product_variant`:**

```sql
ALTER TABLE product_variant
  ADD COLUMN tax_category_id INT NULL,
  ADD CONSTRAINT fk_product_variant_tax_category
    FOREIGN KEY (tax_category_id)
    REFERENCES tax_category(id)
    ON DELETE SET NULL;
```

**Partial unique constraint on at-most-one-open Price per scope:**

The epic specifies a unique constraint on `(variant_id, currency)` where `valid_to IS NULL`. MySQL 8 does **not** support partial / filtered unique indexes the way PostgreSQL does. Two options:

- **Functional index** on `(variant_id, currency, COALESCE(valid_to, '9999-12-31 23:59:59'))` made `UNIQUE` — works in MySQL 8.0.13+, treats open rows as conflicting because they share the sentinel `valid_to`. **Caveat**: requires that closed Prices do not have `valid_to` set to the literal `'9999-12-31 23:59:59'`. The model rejects this at construction (it asserts `validFrom < validTo` but does not check the sentinel; add a guard in the model — `validTo` must not equal the sentinel — to make the DB constraint match the domain rule).
- **Application-level enforcement only** — the `SetPriceUseCase` reads-and-closes-and-inserts inside a single transaction with row-level locking (`SELECT … FOR UPDATE` on the predecessor row).

**Decision**: implement **both** belt-and-braces. The functional unique index is added in the migration (defends against concurrent inserts from any path); the use case in task-03 still does its read-and-close inside a transaction with `SELECT … FOR UPDATE` (defends against the lower-throughput happy path and gives a clean error rather than a raw `Duplicate entry` from the DB). Document the choice in `02-price-domain-and-append-only-history.md`.

If the MySQL version in `docker-compose.yml` is below 8.0.13, document that the partial-unique constraint falls back to application-level only and the concurrency test in task-03 covers the gap. **Action**: read `docker-compose.yml` for the MySQL image tag before writing the migration; downgrade gracefully if 5.7 / 8.0.0–8.0.12. (Epic-01's seed and migrations have already booted MySQL successfully — use whatever tag is already in `docker-compose.yml`.)

## `PricingModule` modification

Replace:

```ts
imports: [TypeOrmModule.forFeature([])],
```

with:

```ts
imports: [TypeOrmModule.forFeature([PriceEntity, TaxCategoryEntity])],
providers: [
  { provide: PRICE_REPOSITORY_PORT, useClass: PriceTypeormRepository },
  { provide: TAX_CATEGORY_REPOSITORY_PORT, useClass: TaxCategoryTypeormRepository },
  { provide: CLOCK_PORT, useClass: SystemClockAdapter },
],
exports: [PRICE_REPOSITORY_PORT, TAX_CATEGORY_REPOSITORY_PORT, CLOCK_PORT],
```

(`exports:` covers the future task-04 cross-module port injection — `Publish Product` lives in `catalog/` and needs `SelectApplicablePriceUseCase`; task-04 will export the use case from `PricingModule`, but the repository / clock ports must be exported here so dependent modules wire correctly via DI.)

## `apps/catalog-microservice/src/app/app.module.ts` — modification

Extend `DatabaseModule.forRoot([…])` with `PriceEntity` and `TaxCategoryEntity`. Maintain the existing order convention (alphabetical or topological — match what the file already does).

## `ProductVariant` entity / model / mapper changes

- `product-variant.entity.ts`: add `@Column({ name: 'tax_category_id', type: 'int', nullable: true }) taxCategoryId: number | null;`. No `@ManyToOne(() => TaxCategoryEntity, …)` relation — the FK is enforced at the DB level only. Going further (object-graph relation) would couple the `catalog/` module to the `pricing/` module at the persistence layer, which the boundaries lint disallows. The opaque `number | null` shape is deliberate.
- `product-variant.model.ts`: add the `taxCategoryId: number | null` field, default `null`. No invariant — any non-null value should resolve to an existing TaxCategory at the use-case layer, but no FK check is done in the domain (the DB enforces). Add a small mutator `attachTaxCategory(taxCategoryId: number): void` and `clearTaxCategory(): void` for the api-gateway PATCH endpoint in task-05 to call; the mutators only set the field — no other side effects.
- `product-variant.mapper.ts`: serialise / deserialise the new field.

## Tests

Unit specs added in this task:

- `apps/catalog-microservice/src/modules/pricing/domain/spec/price.model.spec.ts`:
  - `Price.create` rejects `currency = 'usd-extra'` (not 3 chars).
  - `Price.create` uppercases `'usd'` → `'USD'`.
  - `Price.create` rejects `amountMinor = -1`.
  - `Price.create` rejects `validFrom = past` against a fake clock at `now`.
  - `Price.create` rejects `validFrom >= validTo` when `validTo` is set.
  - `Price.importHistorical` accepts `validFrom = past`.
  - `Price.closeAt` produces a new instance whose `validTo` matches the input; the original is unchanged (no in-place mutation).
  - `Price.closeAt` rejects closing an already-closed Price.
  - `Price.closeAt` rejects closing at an instant before `validFrom`.
- `apps/catalog-microservice/src/modules/pricing/domain/spec/tax-category.model.spec.ts`:
  - `TaxCategory.create` uppercases lowercase codes.
  - `TaxCategory.create` rejects `code = 'has-dash'`, `code = '0LEADS_WITH_DIGIT'`, `code = ''`, `code = ('A' * 51)`.
  - `name` length bounds enforced.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/spec/price.mapper.spec.ts` and similar for tax-category — round-trip the mapper (model → entity → model is identity).
- The arch-lint spec from task-01 is **not** modified here — but **verify** it still passes after the new files land (any accidental import of `catalog/domain/*` from `pricing/domain/*` should be caught by the existing fixture block).

The use-case specs are deliberately deferred to task-03.

## Files to add

- `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts`.
- `apps/catalog-microservice/src/modules/pricing/domain/tax-category.model.ts`.
- `apps/catalog-microservice/src/modules/pricing/domain/currency-code.ts`.
- `apps/catalog-microservice/src/modules/pricing/domain/money.ts`.
- `apps/catalog-microservice/src/modules/pricing/domain/spec/price.model.spec.ts`.
- `apps/catalog-microservice/src/modules/pricing/domain/spec/tax-category.model.spec.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/ports/price.repository.port.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/ports/tax-category.repository.port.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/ports/clock.port.ts` (only if no shared clock port exists in `libs/`; otherwise reuse).
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/price.entity.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/tax-category.entity.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/price.mapper.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/tax-category.mapper.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/price.typeorm.repository.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/tax-category.typeorm.repository.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/spec/price.mapper.spec.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/spec/tax-category.mapper.spec.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/system-clock.adapter.ts` (if a shared one is not used).
- `migrations/<timestamp>-CreatePriceAndTaxCategoryTables.ts`.
- `docs/implementation/epic-03-pricing-price-and-tax-category/02-price-domain-and-append-only-history.md`.
- `docs/implementation/epic-03-pricing-price-and-tax-category/03-tax-category-and-variant-attachment.md`.

## Files to modify

- `apps/catalog-microservice/src/modules/pricing/infrastructure/pricing.module.ts` — register entities, providers, exports.
- `apps/catalog-microservice/src/app/app.module.ts` — extend `DatabaseModule.forRoot([…])` entity list.
- `apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts` — add `taxCategoryId` + mutators.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-variant.entity.ts` — add `tax_category_id` column (no relation).
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-variant.mapper.ts` — serialise / deserialise the field.
- `apps/catalog-microservice/src/modules/pricing/index.ts` and the sub-barrels — re-export the new public symbols (port tokens + interfaces only — the implementations stay private).

## Files to delete

None.

## Doc deliverables

### `02-price-domain-and-append-only-history.md`

Target ~180 lines. Sections:

1. **The append-only-for-history rule, as a contract.** What is forbidden, what is allowed. The single in-place UPDATE — `valid_to` on the open row — is described as a "closing of a half-open interval" rather than a content edit, and the model API (`closeAt` returning a new instance) makes this visible at the call site.
2. **The `(variantId, currency)` scope axis.** Why no `stockLocationId`, no channel id, no customer-group id. The walking-skeleton charter: one Price scope only. Forward-link to `epic-15` for the multi-scope extension.
3. **The closed/open interval ledger.** The four valid interval shapes: `[t, ∞)`, `[t1, t2)`, scheduled `[future, ∞)`, scheduled `[future1, future2)`. The illegal shapes: open-ended-with-predecessor-also-open (the partial-unique constraint catches this), `validFrom >= validTo`, `validFrom < epoch`.
4. **The at-most-one-open invariant: belt + braces.** Application transaction with `SELECT … FOR UPDATE` (task-03) + the functional unique index from the migration. Why this duplication is intentional (race-window vs. error-shape distinction).
5. **Resolution semantics, preview.** The read path: `WHERE valid_from ≤ now AND (valid_to IS NULL OR valid_to > now) ORDER BY priority DESC, valid_from DESC LIMIT 1`. Task-03 owns the full doc; here only the SQL shape is shown so the index choice is justified.
6. **Currency validation depth.** Why format-only. The TODO marker.
7. **What audit consumers see (forward-looking).** The `catalog.price.changed` payload from task-03 is the audit log entry. The DB row itself is also the audit trail (no row is ever overwritten except the `valid_to` close, which represents a transition not a content change).
8. **Forward-looking forward-link to `Order.currency`.** Once `epic-05` lands, the cart line snapshots `{ variantId, currency, amountMinor }` from the resolved Price; the order header inherits `currency` from the cart and treats it as immutable. Full discussion in doc `07`.

### `03-tax-category-and-variant-attachment.md`

Target ~120 lines. Sections:

1. **Classification, not rate.** What this epic does (a label table) vs. what it does not do (no rate, no jurisdiction, no engine). Forward-link to `epic-15`.
2. **The `code` convention.** `UPPER_SNAKE_CASE`. Why the model auto-uppercases on construction (resilience to api-gateway input shapes).
3. **The three seeded codes.** `STANDARD`, `REDUCED`, `EXEMPT`. Why these three. (Task-07 owns the actual seed; here only the policy is stated.)
4. **Attachment to `ProductVariant`.** The `tax_category_id` column is nullable. Nullable means "uncategorised"; an uncategorised variant is fine in this epic (`Publish Product` does NOT check for a tax category, only for a price). Why this is the right default for a walking-skeleton commerce surface (tax computation comes later).
5. **The `ON DELETE SET NULL` FK rationale.** TaxCategory rows are never deleted in practice — but if a future admin endpoint allowed deletion of an unused code, any orphaned variant attaches gracefully degrades to "uncategorised" rather than failing the DELETE. Trade-off: a silent data loss vs. a noisy refusal. The walking-skeleton answer is the silent path. Forward-looking note: once `epic-15` lands a rates engine, the deletion path may need to revisit this (and may want `ON DELETE RESTRICT`).
6. **The cross-module ban, as code.** No `@ManyToOne` from `ProductVariantEntity` to `TaxCategoryEntity`. The FK exists at the SQL level; in TypeORM the column is a plain `number | null`. In the domain, `ProductVariant.taxCategoryId` is opaque. This honors the rule from task-01's doc.
7. **The PATCH endpoint, preview.** `PATCH /api/catalog/variants/:variantId/tax-category` is the only operation that writes this field after variant creation. Task-05 owns the endpoint. The endpoint accepts `taxCategoryCode` (not the id) — string codes are stable; ids are not.

## Carryover produced (consumed by task-03 onward)

- `Price` and `TaxCategory` exist as domain models + entities + repository implementations.
- `PriceRepositoryPort` and `TaxCategoryRepositoryPort` exist as injection tokens; the typeorm adapters are wired in `PricingModule.providers`.
- `ClockPort` exists and is wired.
- `product_variant.tax_category_id` exists in MySQL and is reachable via `ProductVariant.taxCategoryId` in the domain.
- The migration `CreatePriceAndTaxCategoryTables` is on disk and runs cleanly on a fresh schema.
- Docs `02-price-domain-and-append-only-history.md` and `03-tax-category-and-variant-attachment.md` exist.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the new `price.model.spec.ts`, `tax-category.model.spec.ts`, and the two mapper specs are all green; the arch-lint spec from task-01 still passes (no cross-module imports introduced).
- [ ] `yarn build:catalog-microservice` succeeds.
- [ ] `docker compose up -d mysql && yarn migration:run` applies the new migration cleanly. A second `yarn migration:run` is a no-op (idempotent under TypeORM's migrations table).
- [ ] `yarn migration:revert` reverses the migration cleanly (drops `price`, `tax_category`, the `tax_category_id` column + FK).
- [ ] `SHOW INDEX FROM price;` shows `idx_price_lookup` on `(variant_id, currency, valid_from)`, and the functional unique index (if the MySQL version supports it).
- [ ] `SHOW CREATE TABLE product_variant;` includes the `tax_category_id` column and the `fk_product_variant_tax_category` FK.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Docs `02-price-domain-and-append-only-history.md` and `03-tax-category-and-variant-attachment.md` exist at the paths above and are filled per the section lists.
