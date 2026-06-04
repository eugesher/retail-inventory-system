# 03 — `TaxCategory` and variant attachment

This document records the `TaxCategory` classification label — its
classification-only semantics, the `tax_category` table, and the nullable
`product_variant.tax_category_id` foreign key that lets a variant point at one
category. It is the companion to
[02 — The `Price` domain and the append-only history](02-price-domain-and-append-only-history.md);
both realize
[ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md).

> **Status:** the domain model, the entity/table, the FK column, and the
> repository read/write methods exist. The **attach use case and the gateway
> endpoint** that let an operator point a variant at a tax category are completed
> by a later document in this folder — see
> [§4 Completed later](#4-completed-later) for the exact surface that remains.

## 1. Classification-only semantics

A `TaxCategory` answers one question: *what kind of thing is this, for tax
purposes?* — "standard-rated", "reduced-rate", "zero-rated", "exempt". It is a
**label**, not a calculator. The model (`domain/tax-category.model.ts`) is a
framework-free class with three fields:

- `code` — a stable, machine-facing identifier in **UPPER_SNAKE_CASE**, matching
  `^[A-Z][A-Z0-9_]*$` (`TAX_CATEGORY_CODE_INVALID`). This is what other systems
  and seed data reference; it does not change.
- `name` — a human-facing label, non-empty (`TAX_CATEGORY_NAME_REQUIRED`).
- `description` — optional free text (`string | null`).

Both invariants raise a `PricingDomainException` with a typed
`PricingErrorCodeEnum` code, the same typed-error channel `Price` and the catalog
aggregates use (ADR-025 §8). Construction mirrors `Price`: `TaxCategory.create`
for a brand-new label (id `null`) and `TaxCategory.reconstitute` for a row loaded
from storage.

### Rate computation is explicitly deferred

What a `TaxCategory` deliberately does **not** carry: a **rate**, a
**jurisdiction**, a **rounding rule**, or any **conversion** logic. Computing tax
— "this category, in this region, at this rate, rounded this way" — is a separate
future tax-computation capability. Modelling a single `rate` column here would be
the same mistake as fabricating a price scope nobody can fill (ADR-026 §2): it
would bake one jurisdiction's assumption into a label that is supposed to be
jurisdiction-neutral. The category is the *classification*; a future capability
maps `(category, jurisdiction) → rate` without reshaping this label set. There
are **no rates and no jurisdictions** in this capability.

### `code` uniqueness is a repository-level invariant

Global `code` uniqueness is **not** enforced in the model — the domain cannot
see other rows. It is a repository-level guarantee: the `UC_TAX_CATEGORY_CODE`
UNIQUE constraint in the schema is the hard guard, and a use-case pre-check
(`findTaxCategoryByCode`) gives a clean typed `TAX_CATEGORY_CODE_TAKEN` rejection
instead of a raw driver error. This is the same `slug`/`sku` convention catalog
uses (ADR-025). The model spec asserts the model itself does **not** self-enforce
uniqueness (two `TaxCategory.create` calls with the same code both succeed), and
that the duplicate is detected through a repository test double — the pre-check a
future use case runs.

## 2. The `tax_category` table

`TaxCategoryEntity` (`infrastructure/persistence/tax-category.entity.ts`) extends
`BaseEntity` (ADR-019). The migration `…-CreatePricingTables` creates:

```sql
CREATE TABLE tax_category (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(50)   NOT NULL,
  name        VARCHAR(255)  NOT NULL,
  description VARCHAR(1000) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  TIMESTAMP NULL,
  CONSTRAINT UC_TAX_CATEGORY_CODE UNIQUE (code)
);
```

The `id` is `INT UNSIGNED` (a label set is small — no BIGINT needed), matching the
entity's `@PrimaryGeneratedColumn()` int metadata. `deleted_at` is inherited from
`BaseEntity` but stays **inert**: a tax category is a static label, never
soft-deleted. `SnakeNamingStrategy` needs no `@Column({ name })` overrides — every
field is a single word.

The repository methods over it (on `IPricingRepositoryPort`) are
`createTaxCategory` (insert; the caller pre-checks the code), `listTaxCategories`
(all categories, ordered by `code`), and `findTaxCategoryByCode` (the uniqueness
pre-check / lookup).

## 3. The variant → tax-category link

A variant points at **one** tax category through a foreign key the same migration
adds to the catalog `product_variant` table:

```sql
ALTER TABLE product_variant
  ADD COLUMN tax_category_id INT UNSIGNED NULL,
  ADD CONSTRAINT FK_PRODUCT_VARIANT_TAX_CATEGORY FOREIGN KEY (tax_category_id)
    REFERENCES tax_category (id) ON DELETE SET NULL;
```

Two deliberate choices:

- **The column is NULLABLE.** A variant may be **unclassified** — having no tax
  category is a valid, expected state (a draft variant, or one whose
  classification is not yet decided). Nothing forces a category at variant
  creation.
- **`ON DELETE SET NULL`.** Removing a tax category **orphans its variants to
  "unclassified"** rather than blocking the delete (as `ON DELETE RESTRICT`
  would) or cascading a variant delete (as `ON DELETE CASCADE` would — a
  catastrophe, since a tax label has nothing to do with whether a sellable unit
  should exist). The label can be retired; the variants survive, merely
  unclassified.

The FK column is added to a table the **catalog** module owns, but it is added by
the **pricing** migration because the link is a pricing concern — pricing depends
on catalog (the variant exists first), not the reverse. The pricing domain still
never imports the catalog domain; the coupling is the FK only (ADR-026 §5).

## 4. Completed later

The pieces that turn this label into an operator-usable feature are completed by
a later document in this folder. What remains:

- **`attachTaxCategoryToVariant` on the repository port** — write the
  `product_variant.tax_category_id` FK for a given `(variantId, taxCategoryId)`,
  plus the variant-tax-header read method that resolves a variant's current
  category.
- **The attach use case** — validate that both the variant and the tax category
  exist (raising `VARIANT_NOT_FOUND` / `TAX_CATEGORY_NOT_FOUND` from the already
  defined `PricingErrorCodeEnum`), then set the FK.
- **The create-tax-category and list-tax-category use cases** — wrapping
  `createTaxCategory` (with the `TAX_CATEGORY_CODE_TAKEN` pre-check) and
  `listTaxCategories`.
- **The gateway endpoints and their `http/*.http` entries** — the HTTP surface
  that fronts the above over `/api/...`, permission-gated by `pricing:write`.

Those build directly on the model, the table, the FK column, and the three
repository methods recorded here — none of which they reshape.
