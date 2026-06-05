# 03 — `TaxCategory` and variant attachment

This document records the `TaxCategory` classification label — its
classification-only semantics, the `tax_category` table, and the nullable
`product_variant.tax_category_id` foreign key that lets a variant point at one
category. It is the companion to
[02 — The `Price` domain and the append-only history](02-price-domain-and-append-only-history.md);
both realize
[ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md).

> **Status:** complete through the microservice RPC surface. The domain model,
> the `tax_category` table, the `product_variant.tax_category_id` FK, the
> repository read/write methods, the three tax use cases, and their three
> `catalog_queue` RPC handlers all exist (§4–§6). The **gateway HTTP endpoints**
> that front these RPCs over `/api/...` (permission-gated by `pricing:write`) are
> the remaining surface and land with the gateway pricing endpoints.

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

## 4. The tax-category use cases (Create / List)

Two write/read use cases wrap the label set
(`application/use-cases/`). Both return the `TaxCategoryView` wire DTO (a class
carrying `@ApiResponseProperty`, mirroring `PriceView` / `ProductView`) through a
shared `tax-category-view.factory.ts` so the projection lives in one place.

**`CreateTaxCategoryUseCase`** (`catalog.tax-category.create`):

1. **Build first.** `TaxCategory.create({ code, name, description })` runs the
   domain invariants — a malformed `code` raises `TAX_CATEGORY_CODE_INVALID`, a
   blank `name` raises `TAX_CATEGORY_NAME_REQUIRED` — *before* the use case
   touches the repository. A bad payload should never reach the uniqueness check.
2. **Pre-check uniqueness.** `findTaxCategoryByCode(code)`; a non-null hit raises
   `TAX_CATEGORY_CODE_TAKEN`. This is the two-layer guard ADR-026 §6 describes: the
   pre-check turns the common duplicate into a tidy typed rejection, and the
   `UC_TAX_CATEGORY_CODE` UNIQUE constraint is the hard backstop if two creates
   race past the pre-check.
3. **Persist.** `createTaxCategory(...)` → `TaxCategoryView`. **No event** — a tax
   label is static reference data, not a business fact other services react to.

**`ListTaxCategoriesUseCase`** (`catalog.tax-category.list`): `listTaxCategories()`
(ordered by `code`) → `TaxCategoryView[]`. There is no paging or filter: a
tax-category set is a small, static handful of rows, so the whole list returns in
one shot. The query carries only a `correlationId` (`ICorrelationPayload`) — there
is nothing to scope by. No event.

## 5. Attaching a tax category to a variant

`AttachTaxCategoryToVariantUseCase` (`catalog.variant.set-tax-category`) points a
variant at one category by writing the `product_variant.tax_category_id` FK. The
flow:

1. **Resolve the category by code.** The caller references the category by its
   stable `taxCategoryCode`, not its surrogate id — it should not need to know the
   internal id of a label it names by code. `findTaxCategoryByCode(code)`; a miss
   raises `TAX_CATEGORY_NOT_FOUND` (→ 404).
2. **Check the variant exists.** `findVariantTaxHeader(variantId)`; `null` (an
   empty result set) raises `VARIANT_NOT_FOUND` (→ 404). The header read doubles
   as the existence guard — without it the FK write would silently affect zero
   rows.
3. **Write the FK.** `attachTaxCategoryToVariant(variantId, taxCategory.id)`.
4. **Re-read and return the updated header.** A second `findVariantTaxHeader`
   builds the `VariantTaxHeaderView` from storage rather than assembling it from
   the inputs, so the response reflects exactly what was persisted.

Re-classifying a variant that already carries a category is the same path — the
FK is simply overwritten. There is **no event**: re-classifying a variant is an
operator edit, not a fact other services subscribe to.

### Why the FK write goes through a parameterized query, not a cross-module import

`tax_category_id` is a **pricing-introduced column on the catalog-owned
`product_variant` table** (§3): the pricing migration added it because the link is
a pricing concern, even though the table belongs to catalog. Pricing owns the
column's semantics — but it must reach it **without importing the catalog
`ProductVariantEntity`**. A cross-module infrastructure import is exactly what the
boundaries lint forbids (ADR-017): the pricing and catalog modules colocate in one
microservice but stay independently reasoned, coupled only by the opaque
`variantId` and the database foreign key (ADR-025 / ADR-026 §5).

So `PricingTypeormRepository` reads and writes the column with **parameterized
SQL** through its injected TypeORM manager:

```sql
-- attachTaxCategoryToVariant
UPDATE product_variant SET tax_category_id = ? WHERE id = ?

-- findVariantTaxHeader
SELECT pv.id, pv.sku, pv.tax_category_id, tc.code
  FROM product_variant pv
  LEFT JOIN tax_category tc ON tc.id = pv.tax_category_id
 WHERE pv.id = ?
```

The `?` placeholders are bound by the driver, so the ids are never
string-interpolated into the SQL (no injection surface). The `LEFT JOIN` returns
`NULL` category columns for an unclassified variant rather than dropping the row,
and an empty result set means the variant does not exist. The numeric columns are
coerced defensively (`Number(...)`, guarding `null` so an unclassified variant's
`tax_category_id` stays `null` rather than collapsing to `0`) — mysql2 can surface
them as strings. This is the **same opaque-`variantId` boundary** the `Price`
ledger uses for its `FK_PRICE_VARIANT` (ADR-026 §5): the FK is the only structural
coupling; the TypeScript modules never see each other's types.

### The "updated variant header" response

The attach command returns a `VariantTaxHeaderView` — the minimal projection of a
variant's tax classification *after* the write:

```ts
class VariantTaxHeaderView {
  variantId: number;
  sku: string;
  taxCategoryId: number | null;   // null when unclassified
  taxCategoryCode: string | null; // the joined code, null when unclassified
}
```

It is deliberately **not** the full variant view: pricing reads only the columns it
needs through the parameterized query, so it never depends on the shape of the
catalog read model. The gateway PATCH that fronts this RPC returns the header
verbatim, so an operator immediately sees the variant's new classification.

## 6. The RPC surface

Three routing keys join `catalog_queue`, registered lock-step in both
`ROUTING_KEYS` (`libs/messaging`) and `MicroserviceMessagePatternEnum`
(`libs/contracts`) — the alignment is asserted by `routing-keys.constants.spec.ts`
(ADR-008):

| Routing key | RPC | Use case |
| --- | --- | --- |
| `catalog.tax-category.create` | Create a tax category | `CreateTaxCategoryUseCase` |
| `catalog.tax-category.list` | List all tax categories | `ListTaxCategoriesUseCase` |
| `catalog.variant.set-tax-category` | Attach a category to a variant | `AttachTaxCategoryToVariantUseCase` |

`PricingController` (`presentation/pricing.controller.ts`) carries the three thin
`@MessagePattern` handlers alongside the three price RPCs — six in all on
`catalog_queue`. A failure raises a `PricingDomainException` whose typed code the
`PricingRpcExceptionFilter` maps onto an HTTP status (`TAX_CATEGORY_CODE_TAKEN` →
409; `TAX_CATEGORY_NOT_FOUND` / `VARIANT_NOT_FOUND` → 404; the `*_INVALID` /
`*_REQUIRED` codes → 400) so the gateway surfaces the right status rather than a
blanket 500.

## 7. What is still deferred

Rates and jurisdictions remain out of scope, as §1 ("Rate computation is
explicitly deferred") records: a `TaxCategory` stays a jurisdiction-neutral
classification label, and computing tax —
`(category, jurisdiction) → rate`, rounded and converted — is a separate future
tax-computation capability that maps over this label set without reshaping it.

The only remaining piece of *this* capability is the **gateway HTTP surface** that
fronts the three RPCs over `/api/...` (permission-gated by `pricing:write`) and its
`http/*.http` entries. Those build directly on the use cases and contracts recorded
here — none of which they reshape.
