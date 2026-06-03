---
epic: epic-03
task_number: 4
title: TaxCategory use cases (Create / List) + variant attachment
depends_on: [1, 2, 3]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/03-tax-category-and-variant-attachment.md
adr_deliverable: none
---

# Task 04 — TaxCategory use cases (Create / List) + variant attachment

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-008** (routing keys + the lock-step legacy enum), **ADR-017**
(the pricing module's infrastructure may **not** import the catalog module's
`ProductVariant` entity — the cross-module link is the opaque `variantId` via a
parameterized query, never a TypeScript import), **ADR-024** (the
`pricing:write` gate, applied at the gateway in task-06), and **ADR-026** (TaxCategory
is a classification label only — no rates).

## Goal

Finish the TaxCategory surface inside the pricing module: Create TaxCategory and
List TaxCategory, plus attaching a TaxCategory to a variant by writing the
`product_variant.tax_category_id` FK column that task-02 introduced. Expose the
three tax RPCs on `catalog_queue` and register their routing keys. This completes
the `03-tax-category-and-variant-attachment.md` doc started in task-02.

## Entry state assumed

- task-01 → task-03 carryover present. The `pricing` module has its `Price`
  use cases, the events publisher, `PricingController` (three price RPCs),
  `PricingRpcExceptionFilter`, and `IPricingRepositoryPort` with the tax read
  methods `createTaxCategory` / `listTaxCategories` / `findTaxCategoryByCode`.
- `PricingErrorCodeEnum` already carries `TAX_CATEGORY_CODE_INVALID`,
  `TAX_CATEGORY_NAME_REQUIRED`, `TAX_CATEGORY_CODE_TAKEN`,
  `TAX_CATEGORY_NOT_FOUND`, `VARIANT_NOT_FOUND` (from task-02). If any is missing,
  add it here.
- `product_variant.tax_category_id` exists (nullable FK → `tax_category`,
  `ON DELETE SET NULL`). No row references a TaxCategory yet.
- The `tax_category` table is empty (the seed rows land in task-08).

## Scope

**In**
- `pricing/application/use-cases/`: `CreateTaxCategoryUseCase`,
  `ListTaxCategoriesUseCase`, `AttachTaxCategoryToVariantUseCase` + specs.
- Extend `IPricingRepositoryPort` + `PricingTypeormRepository` with
  `attachTaxCategoryToVariant(variantId, taxCategoryId)` and
  `findVariantTaxHeader(variantId)` — both via **parameterized queries** against
  `product_variant` (no catalog entity import).
- Contracts in `libs/contracts/catalog/`: `ICreateTaxCategoryPayload`,
  `IAttachVariantTaxCategoryPayload`, `TaxCategoryView`, `VariantTaxHeaderView`
  (+ barrels). (List needs only a `correlationId`-carrying query, or reuse
  `ICorrelationPayload`.)
- Routing keys `catalog.tax-category.create`, `catalog.tax-category.list`,
  `catalog.variant.set-tax-category` in **both** `ROUTING_KEYS` and
  `MicroserviceMessagePatternEnum`.
- Three new `@MessagePattern` handlers on `PricingController`; the three use cases
  registered in `pricing.module.ts`.
- Complete `03-tax-category-and-variant-attachment.md`.

**Out**
- Publish hard-fail (task-05); gateway endpoints (task-06); `.http` (task-07);
  the three seeded TaxCategories + the variant attachments in the seed (task-08).
- Detaching a TaxCategory (setting it back to NULL) — out of scope here; the FK's
  `ON DELETE SET NULL` covers the category-deletion case.

## Contract shapes

```ts
// interfaces/tax-category-create.interface.ts
export interface ICreateTaxCategoryPayload extends ICorrelationPayload {
  code: string;          // UPPER_SNAKE_CASE
  name: string;
  description?: string;
}

// interfaces/variant-tax-category.interface.ts
export interface IAttachVariantTaxCategoryPayload extends ICorrelationPayload {
  variantId: number;
  taxCategoryCode: string;
}

// dto/tax-category.view.ts — a CLASS with @ApiResponseProperty (the lib-contracts
// response-view convention, mirroring ProductView), so the gateway can use it as
// @ApiOkResponse({ type: TaxCategoryView }). Not an interface.
export class TaxCategoryView {
  @ApiResponseProperty() public id: number;
  @ApiResponseProperty() public code: string;
  @ApiResponseProperty() public name: string;
  @ApiResponseProperty() public description: string | null;
}

// dto/variant-tax-header.view.ts — the "updated variant header" the PATCH returns.
// Also a CLASS with @ApiResponseProperty.
export class VariantTaxHeaderView {
  @ApiResponseProperty() public variantId: number;
  @ApiResponseProperty() public sku: string;
  @ApiResponseProperty() public taxCategoryId: number | null;
  @ApiResponseProperty() public taxCategoryCode: string | null;
}
```

`CreateTaxCategoryUseCase` returns `TaxCategoryView`; `ListTaxCategoriesUseCase`
returns `TaxCategoryView[]`; `AttachTaxCategoryToVariantUseCase` returns
`VariantTaxHeaderView`.

## Use-case behavior

**`CreateTaxCategoryUseCase`** (`catalog.tax-category.create`):
1. Build `TaxCategory` from the payload (the model validates `code`
   UPPER_SNAKE_CASE + non-empty `name`).
2. Pre-check `findTaxCategoryByCode(code)`; if present, throw
   `TAX_CATEGORY_CODE_TAKEN` (the UNIQUE constraint is the hard backstop).
3. `repo.createTaxCategory(...)` → return `TaxCategoryView`. No event.

**`ListTaxCategoriesUseCase`** (`catalog.tax-category.list`): `repo.listTaxCategories()`
→ `TaxCategoryView[]` (the small static set). No event.

**`AttachTaxCategoryToVariantUseCase`** (`catalog.variant.set-tax-category`):
1. `const tc = await repo.findTaxCategoryByCode(taxCategoryCode)`; if `null` →
   `TAX_CATEGORY_NOT_FOUND`.
2. `const header = await repo.findVariantTaxHeader(variantId)`; if `null` →
   `VARIANT_NOT_FOUND`.
3. `await repo.attachTaxCategoryToVariant(variantId, tc.id)`.
4. Return `repo.findVariantTaxHeader(variantId)` (now carrying `taxCategoryId` +
   `taxCategoryCode`) as `VariantTaxHeaderView`. No event.

## Repository extension (parameterized — no catalog import)

Add to `IPricingRepositoryPort` and implement in `PricingTypeormRepository`:

```ts
attachTaxCategoryToVariant(variantId: number, taxCategoryId: number): Promise<void>;
findVariantTaxHeader(variantId: number): Promise<{
  variantId: number; sku: string; taxCategoryId: number | null; taxCategoryCode: string | null;
} | null>;
```

`tax_category_id` is a pricing-introduced column on `product_variant`; pricing
owns its semantics. The adapter reads/writes it with **parameterized SQL** through
its injected manager/`DataSource` — e.g. `UPDATE product_variant SET
tax_category_id = ? WHERE id = ?` and a `SELECT pv.id, pv.sku, pv.tax_category_id,
tc.code FROM product_variant pv LEFT JOIN tax_category tc ON tc.id =
pv.tax_category_id WHERE pv.id = ?`. **Do not** import the catalog
`ProductVariantEntity` (a cross-module infrastructure import the boundaries lint
forbids); the FK + the opaque `variantId` are the only coupling (the epic's
forbidden-import rule, ADR-025/ADR-017).

## Files to add

- `apps/catalog-microservice/src/modules/pricing/application/use-cases/create-tax-category.use-case.ts`
- `.../use-cases/list-tax-categories.use-case.ts`
- `.../use-cases/attach-tax-category-to-variant.use-case.ts`
- `.../use-cases/spec/create-tax-category.use-case.spec.ts`
- `.../use-cases/spec/list-tax-categories.use-case.spec.ts`
- `.../use-cases/spec/attach-tax-category-to-variant.use-case.spec.ts`
- `libs/contracts/catalog/interfaces/tax-category-create.interface.ts`
- `libs/contracts/catalog/interfaces/variant-tax-category.interface.ts`
- `libs/contracts/catalog/dto/tax-category.view.ts`
- `libs/contracts/catalog/dto/variant-tax-header.view.ts`

## Files to modify

- `libs/messaging/routing-keys.constants.ts` + `microservice-message-pattern.enum.ts`
  — add the three tax routing keys (lock-step).
- `libs/contracts/catalog/{interfaces,dto}/index.ts` — barrels.
- `apps/catalog-microservice/src/modules/pricing/application/ports/pricing.repository.port.ts`
  — add the two variant-tax methods.
- `.../infrastructure/persistence/pricing-typeorm.repository.ts` — implement them
  (parameterized queries).
- `.../presentation/pricing.controller.ts` — add the three `@MessagePattern`s.
- `.../application/use-cases/index.ts` — barrel the three use cases.
- `.../pricing.module.ts` — register the three use cases.
- `apps/catalog-microservice/.../pricing/domain/pricing.exception.ts` — only if a
  needed `PricingErrorCodeEnum` member is missing.
- `docs/implementation/03-pricing-price-and-tax-category/03-tax-category-and-variant-attachment.md`
  — complete the use-case + attachment half.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`), using the in-memory repository double extended with
  the tax methods:
  - `create-tax-category.use-case.spec.ts` — builds + persists; rejects a
    duplicate code with `TAX_CATEGORY_CODE_TAKEN`; rejects a non-UPPER_SNAKE code
    (domain).
  - `list-tax-categories.use-case.spec.ts` — returns the persisted set as views.
  - `attach-tax-category-to-variant.use-case.spec.ts` — happy attach returns the
    header with the code populated; `TAX_CATEGORY_NOT_FOUND` for an unknown code;
    `VARIANT_NOT_FOUND` for an unknown variant.
- `yarn test:e2e` still passes (no HTTP route until task-06).

## Doc deliverable

Complete `03-tax-category-and-variant-attachment.md` (started in task-02): the
Create/List use cases; the attach flow + why the variant FK write goes through a
parameterized query rather than a cross-module entity import (the
`variantId`-as-opaque-link boundary); the "updated variant header" response; and a
restatement that rates/jurisdictions are deferred to a future tax-computation
capability (the doc may reference `docs/extensions/…` once that capability ships —
do not invent the path now).

## Carryover to read

`carryover-01.md` … `carryover-03.md`.

## Carryover to produce

Write `carryover-04.md`. Capture: the three tax routing keys; the tax contract
type names; the two new repository methods + that they use parameterized SQL
(no catalog import); the three use cases + their `PricingController` handlers; the
`VariantTaxHeaderView` shape the gateway PATCH returns. Note the remaining gaps
(publish hard-fail → task-05; gateway endpoints → task-06; seed → task-08). Verify
commands.

## Exit criteria

- [ ] `catalog.tax-category.create/list` and `catalog.variant.set-tax-category`
      are handled by `PricingController`; routing keys exist in both constant
      surfaces; `routing-keys.constants.spec.ts` is green.
- [ ] The variant-tax write/read go through parameterized SQL; the pricing module
      imports nothing from the catalog module (`yarn lint` clean).
- [ ] The three tax use cases exist with the documented behavior and specs.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the three new specs are green.
- [ ] `yarn test:e2e` passes.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots the
      catalog service; all six pricing RPC handlers register on `catalog_queue`.
- [ ] `03-tax-category-and-variant-attachment.md` is complete.
- [ ] The self-containment grep is clean.
- [ ] `carryover-04.md` is written.
