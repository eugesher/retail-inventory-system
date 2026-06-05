# Carryover 04 — TaxCategory use cases (Create / List) + variant attachment

State handed forward from task-04 to task-05 (and beyond). Read this before
touching the pricing module. (Read `carryover-01.md` … `carryover-03.md` first.)

## Entry state for task-05

The pricing module now has its **full** application + RPC surface on disk under
`apps/catalog-microservice/src/modules/pricing/` — six RPCs on `catalog_queue`
(three price + three tax-category). The catalog service boots clean as an RMQ
server and all six pricing handlers register without duplicate-pattern errors
(verified — see "How to verify"). lint / unit / e2e all green.

What is now wired on top of task-03 (the three price RPCs):

- **`application/use-cases/`** — added `CreateTaxCategoryUseCase`,
  `ListTaxCategoriesUseCase`, `AttachTaxCategoryToVariantUseCase`, and a shared
  `tax-category-view.factory.ts` (`toTaxCategoryView`, mirrors
  `price-view.factory.ts`). Barrel exports all three.
- **`application/ports/pricing.repository.port.ts`** — `IPricingRepositoryPort`
  gained two variant-tax methods (below). No new port symbol.
- **`infrastructure/persistence/pricing-typeorm.repository.ts`** — implements the
  two methods with **parameterized SQL** through the injected
  `priceRepository.manager` (`EntityManager.query<T>(...)`), **never** importing the
  catalog `ProductVariantEntity` (the boundaries-lint red line; opaque `variantId`
  + the FK are the only coupling — ADR-017 / ADR-026 §5).
- **`presentation/pricing.controller.ts`** — three new `@MessagePattern`s
  (below); six handlers total. `PricingRpcExceptionFilter` was already total over
  `PricingErrorCodeEnum`, so **no filter change** was needed (all tax codes were
  seeded in task-02).
- **`pricing.module.ts`** — registers the three new use cases. No other wiring
  change (the controller, `MicroserviceClientCatalogModule`, repository binding,
  and `APP_FILTER` were already present from task-03).

`app/app.module.ts`, `domain/`, and `infrastructure/messaging/` are **unchanged**.
No migration, no seed change (the `tax_category` table + the
`product_variant.tax_category_id` FK already exist from task-02; rows land in
task-08). `PricingErrorCodeEnum` was **not** extended — every needed tax code was
already present.

## Routing keys (three new, in BOTH places, value-for-value)

Added to `libs/messaging/routing-keys.constants.ts` (`ROUTING_KEYS`) **and**
`libs/contracts/microservices/microservice-message-pattern.enum.ts`
(`MicroserviceMessagePatternEnum`); `routing-keys.constants.spec.ts` asserts the
alignment (three new `.toBe` assertions; the `uses dotted naming convention` test
already covers them — the dash in `tax-category` / `set-tax-category` matches the
`[a-z-]+` token regex):

| Key (member) | Wire value | Kind |
| --- | --- | --- |
| `CATALOG_TAX_CATEGORY_CREATE` | `catalog.tax-category.create` | RPC |
| `CATALOG_TAX_CATEGORY_LIST` | `catalog.tax-category.list` | RPC |
| `CATALOG_VARIANT_SET_TAX_CATEGORY` | `catalog.variant.set-tax-category` | RPC |

## Contracts (`libs/contracts/catalog/`, barrels updated)

- `interfaces/tax-category-create.interface.ts` — **`ICreateTaxCategoryPayload`**
  extends `ICorrelationPayload`: `code: string` (UPPER_SNAKE_CASE), `name: string`,
  `description?: string`.
- `interfaces/variant-tax-category.interface.ts` —
  **`IAttachVariantTaxCategoryPayload`** extends `ICorrelationPayload`:
  `variantId: number`, `taxCategoryCode: string` (the variant is addressed by id,
  the category by its **code**, not its surrogate id).
- `dto/tax-category.view.ts` — **`TaxCategoryView`** (a **class** with
  `@ApiResponseProperty`, like `PriceView`/`ProductView`): `id`, `code`, `name`,
  `description: string | null`.
- `dto/variant-tax-header.view.ts` — **`VariantTaxHeaderView`** (a **class** with
  `@ApiResponseProperty`): `variantId`, `sku`, `taxCategoryId: number | null`,
  `taxCategoryCode: string | null`. **This is the "updated variant header" the
  gateway PATCH (task-06) returns** — the minimal post-write projection, NOT the
  full variant view.
- **List** reuses `ICorrelationPayload` (no dedicated query type — there is
  nothing to scope by).

## New repository methods (parameterized — no catalog import)

On `IPricingRepositoryPort` / `PricingTypeormRepository`:

```ts
attachTaxCategoryToVariant(variantId: number, taxCategoryId: number): Promise<void>;
findVariantTaxHeader(variantId: number): Promise<{
  variantId: number; sku: string; taxCategoryId: number | null; taxCategoryCode: string | null;
} | null>;
```

- `attachTaxCategoryToVariant` → `UPDATE product_variant SET tax_category_id = ?
  WHERE id = ?` with bound args `[taxCategoryId, variantId]`.
- `findVariantTaxHeader` → `SELECT pv.id, pv.sku, pv.tax_category_id, tc.code FROM
  product_variant pv LEFT JOIN tax_category tc ON tc.id = pv.tax_category_id WHERE
  pv.id = ?`. Empty result set → `null` (variant does not exist). Numeric columns
  are coerced with `Number(...)`, **guarding `null`** (so an unclassified variant's
  `tax_category_id` stays `null`, not `0`). Uses `manager.query<IVariantTaxHeaderRow[]>(...)`
  — the typed generic avoids an `as` cast (which `no-unnecessary-type-assertion`
  rejects on the `any`-typed query result) and a `no-unsafe-assignment`.

## Use-case behavior

- **`CreateTaxCategoryUseCase`** (`catalog.tax-category.create`): `TaxCategory.create`
  (domain validates `code`/`name`) → `findTaxCategoryByCode` pre-check (non-null →
  **`TAX_CATEGORY_CODE_TAKEN`**) → `createTaxCategory` → `TaxCategoryView`. No event.
- **`ListTaxCategoriesUseCase`** (`catalog.tax-category.list`): `listTaxCategories()`
  (ordered by `code`) → `TaxCategoryView[]`. Takes `ICorrelationPayload`. No event.
- **`AttachTaxCategoryToVariantUseCase`** (`catalog.variant.set-tax-category`):
  `findTaxCategoryByCode(code)` (null → **`TAX_CATEGORY_NOT_FOUND`**) →
  `findVariantTaxHeader(variantId)` (null → **`VARIANT_NOT_FOUND`**) →
  `attachTaxCategoryToVariant(variantId, tc.id)` → re-read `findVariantTaxHeader`
  → `VariantTaxHeaderView`. Re-classify is the same path (FK overwritten). No event.

All three filter-map to HTTP via the **already-total** `PricingRpcExceptionFilter`
(`TAX_CATEGORY_CODE_TAKEN` → 409; `TAX_CATEGORY_NOT_FOUND` / `VARIANT_NOT_FOUND` →
404; `*_INVALID` / `*_REQUIRED` → 400).

## PricingController `@MessagePattern`s (now six live on `catalog_queue`)

`presentation/pricing.controller.ts`: the three price patterns (task-03) plus
`CATALOG_TAX_CATEGORY_CREATE` → `CreateTaxCategoryUseCase`,
`CATALOG_TAX_CATEGORY_LIST` → `ListTaxCategoriesUseCase`,
`CATALOG_VARIANT_SET_TAX_CATEGORY` → `AttachTaxCategoryToVariantUseCase`.

## Test doubles (extended; reusable by task-05+)

`application/use-cases/spec/test-doubles.ts` — `InMemoryPricingRepository` now
implements the **full** extended port. Added: a `variants` map (`IFakeVariantRow`),
a `seedVariant({ variantId, sku, taxCategoryId? })` helper, and real
`attachTaxCategoryToVariant` / `findVariantTaxHeader` (the latter resolves the code
by scanning the tax-category store by id — the in-memory analogue of the LEFT
JOIN). `createTaxCategory` already assigned ids and keyed by code, so it doubles as
a tax-category seeder.

## Decisions & deviations

- **Added `tax-category-view.factory.ts`** (not in the task's explicit file list) —
  mirrors `price-view.factory.ts`; create + list share `toTaxCategoryView` so the
  projection lives in one place. Idiomatic with the codebase convention.
- **`PricingErrorCodeEnum` unchanged** — task-02 had already seeded
  `TAX_CATEGORY_CODE_INVALID` / `_NAME_REQUIRED` / `_CODE_TAKEN` / `_NOT_FOUND` /
  `VARIANT_NOT_FOUND`. The filter `Record` was already total, so no filter edit.
- **Repo-spec coverage for the two new methods** — added a `query: jest.fn()` to
  the mocked `manager` in `pricing-typeorm.repository.spec.ts` and three cases
  (parameterized UPDATE bound to `[taxCategoryId, variantId]`; empty-set → null;
  string-numeric coercion with the `null` guard). Assertions use
  `toHaveBeenCalledWith(expect.stringContaining(...), params)` to avoid reading
  `mock.calls` (which would surface `any`).

## Known gaps / deferrals (each owned by a later task)

- **Publish hard-fail** (publish blocks a price-less product) → **task-05**, via
  `SelectApplicablePriceUseCase` (the seam carryover-03 describes). task-04 added
  no price check to catalog's `PublishProductUseCase`.
- **Gateway pricing + tax endpoints** → **task-06** (the HTTP surface that fronts
  all six RPCs over `/api/...`, `pricing:write`-gated; the variant PATCH returns
  `VariantTaxHeaderView`). **`http/pricing.http`** → **task-07**.
- **price/tax seed rows + variant attachments + finalization** → **task-08**. No
  seed change in task-04 (the tax RPCs have no HTTP caller until task-06; e2e still
  green without one). The `tax_category` table is still empty.

## How to verify (all run green at end of task-04)

- `yarn lint` — exit 0 (`--max-warnings 0`). No boundary violations; pricing
  imports nothing from the catalog module (the FK write is parameterized SQL).
- `yarn format:check` — clean.
- `yarn test:unit` — **469 tests / 67 suites** pass (14 new since task-03:
  `create-tax-category` (4) / `list-tax-categories` (2) /
  `attach-tax-category-to-variant` (4) use-case specs, plus 4 repo-spec cases for
  the two parameterized methods; the three routing-key assertions extend the
  existing alignment test).
- `yarn build` — exit 0.
- `yarn test:e2e` — **75 tests / 6 suites** pass on a fresh infra reload + migrate
  + seed (no new gateway route; the tax RPCs have no HTTP caller yet).
- Catalog boots + six handlers register: with infra up,
  `node dist/apps/catalog-microservice/main.js` (env from `.env.local`) logs
  `Catalog Microservice is listening for messages`, runs `SELECT version()`, and
  shows **no** error/fatal/warn lines or duplicate-pattern errors (a duplicate
  `@MessagePattern` throws at boot). (`docker compose up -d && yarn migration:run
  && yarn start:dev` is the dev-mode equivalent.)
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`
  → no orchestration references.

## Files added

- `libs/contracts/catalog/interfaces/tax-category-create.interface.ts`
- `libs/contracts/catalog/interfaces/variant-tax-category.interface.ts`
- `libs/contracts/catalog/dto/tax-category.view.ts`
- `libs/contracts/catalog/dto/variant-tax-header.view.ts`
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/create-tax-category.use-case.ts`
- `.../use-cases/list-tax-categories.use-case.ts`
- `.../use-cases/attach-tax-category-to-variant.use-case.ts`
- `.../use-cases/tax-category-view.factory.ts`
- `.../use-cases/spec/create-tax-category.use-case.spec.ts`
- `.../use-cases/spec/list-tax-categories.use-case.spec.ts`
- `.../use-cases/spec/attach-tax-category-to-variant.use-case.spec.ts`
- `tmp/tasks/epic-03-pricing-price-and-tax-category/carryover-04.md` (this file)

## Files modified

- `libs/messaging/routing-keys.constants.ts`, `libs/messaging/spec/routing-keys.constants.spec.ts`
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`
- `libs/contracts/catalog/{interfaces,dto}/index.ts` (barrels)
- `apps/catalog-microservice/src/modules/pricing/application/ports/pricing.repository.port.ts`
- `.../infrastructure/persistence/pricing-typeorm.repository.ts`
- `.../infrastructure/persistence/spec/pricing-typeorm.repository.spec.ts`
- `.../presentation/pricing.controller.ts`
- `.../application/use-cases/index.ts`
- `.../application/use-cases/spec/test-doubles.ts`
- `.../pricing.module.ts`
- `docs/implementation/03-pricing-price-and-tax-category/03-tax-category-and-variant-attachment.md`
- `CLAUDE.md`, `README.md`

## Files deleted

- None.
