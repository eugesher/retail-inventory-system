---
epic: epic-02
task_number: 5
title: Implement the Query Catalog read path — RPC handlers, list/get use cases, read projections
depends_on: [task-01, task-02, task-03, task-04]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/04-catalog-use-cases.md
---

# Task 05 — `Query Catalog` read path (RPC handlers + read use cases)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Add the public-facing browse path: the buyer-facing customer queries paged active products with their variants, fetches a single product by slug, and fetches a single variant by id. The read path is exposed via three new `@MessagePattern` RPC handlers (the api-gateway in task-06 wraps these behind HTTP); the read projections deliberately bypass the aggregate hydration cost where it's cheap to do so.

Per ADR-016 — and the epic's "if a future cached-catalog read path is added" clause — this task does **not** implement a Redis cache for the read path today. It does, however, introduce the cache-key constant + builder in `libs/cache/cache-keys.ts` so a future epic can flip the switch without an API change.

## Entry state assumed

Tasks 1–4 carryover present:

- All four write use cases (Register / AddVariant / Publish / Archive) are live and emit events on state transitions.
- `IProductRepositoryPort.findActiveProducts({ page, pageSize, search })` and `findBySlug(slug)` exist from task-02; this task uses both. `findById(productId)` and `findByVariantSku(sku)` also exist; this task uses `findById` and adds one more method: `findVariantById`.
- `catalog.controller.ts` has four write `@MessagePattern` handlers; this task adds three read handlers.
- Doc `04-catalog-use-cases.md` has its write half complete, with a `<!-- task-05-read-path-anchor -->` HTML comment awaiting replacement.
- `libs/cache/cache-keys.ts` does not yet contain a catalog builder.

## Scope

**In:**

- Three read use cases under `apps/catalog-microservice/src/modules/catalog/application/use-cases/`:
  - `list-active-products.use-case.ts` — paged `{ page, pageSize, search? }` over `status='active'` products, returns `{ rows: ProductReadDto[]; total; page; pageSize }`. Each row carries only the active variants (archived variants are filtered out of the read projection).
  - `get-product-by-slug.use-case.ts` — fetch a Product by slug; returns `ProductReadDto`. If the Product is `archived`, the read path returns 404 (it is hidden from browse — historical orders still join by id, but slug-based browse hides it).
  - `get-variant.use-case.ts` — fetch a single variant by id; returns `VariantReadDto` including a parent-product header. If the parent is `archived`, returns 404.
- One new method on `IProductRepositoryPort`: `findVariantById(variantId: number): Promise<{ product: Product; variant: ProductVariant } | null>`. The adapter implements it via a join on `product_variant` → `product`.
- Two read DTOs in `application/dto/`:
  - `ProductReadDto` — `{ id, name, slug, description, status, variants: VariantReadDto[] }`.
  - `VariantReadDto` — `{ id, productId, sku, gtin, optionValues, weightG, dimensionsMm, status, productSlug, productName }`.
  - The two DTOs are plain interfaces (or class-with-no-decorators); they live in the application layer, not the presentation layer, because they are the read-side representation that crosses the RPC boundary.
- Three new `@MessagePattern` handlers on `presentation/catalog.controller.ts`:
  - `catalog.product.list` → `ListActiveProductsUseCase`.
  - `catalog.product.get` → `GetProductBySlugUseCase`.
  - `catalog.variant.get` → `GetVariantUseCase`.
- Three new RPC routing-key constants in `libs/messaging/routing-keys.constants.ts`:
  - `CATALOG_PRODUCT_LIST = 'catalog.product.list'`.
  - `CATALOG_PRODUCT_GET = 'catalog.product.get'`.
  - `CATALOG_VARIANT_GET = 'catalog.variant.get'`.
- Cache-key scaffolding (no live cache today, but the builder is added so the future cache flip is mechanical):
  - `libs/cache/cache-keys.ts` extended with `productByVariantId(variantId, facet?)` returning `ris:catalog:product:v1:<variantId>[:<facet>]`. Export the constant `CATALOG_PRODUCT_KEY_VERSION = 'v1'`.
- Unit specs:
  - `list-active-products.use-case.spec.ts` — pagination math (page/pageSize clamp, default values), `status='active'` filter, archived-variants filtered, total count returned.
  - `get-product-by-slug.use-case.spec.ts` — happy path; not-found-on-archived; not-found-on-missing.
  - `get-variant.use-case.spec.ts` — happy path; not-found-when-parent-archived; not-found-when-missing.
- Doc deliverable: append the read-path subsection to `04-catalog-use-cases.md` (replace `<!-- task-05-read-path-anchor -->`).

**Out:**

- A live Redis cache for the read path — flagged for a future epic; today only the builder + constant exist.
- The api-gateway side of the read path (`GET /api/catalog/products`, `GET /api/catalog/products/:slug`, `GET /api/catalog/variants/:variantId`) — task-06.
- E2E tests — these live in task-09's seed-and-docs pass once the gateway is wired.

## `list-active-products.use-case.ts` shape

```ts
@Injectable()
export class ListActiveProductsUseCase {
  private static readonly DEFAULT_PAGE_SIZE = 20;
  private static readonly MAX_PAGE_SIZE = 100;

  constructor(@Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepositoryPort) {}

  async execute(input: { page?: number; pageSize?: number; search?: string }): Promise<{
    rows: ProductReadDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(ListActiveProductsUseCase.MAX_PAGE_SIZE, Math.max(1, input.pageSize ?? ListActiveProductsUseCase.DEFAULT_PAGE_SIZE));
    const { rows, total } = await this.products.findActiveProducts({ page, pageSize, search: input.search });
    return {
      rows: rows.map(toProductReadDto), // toProductReadDto strips archived variants
      total,
      page,
      pageSize,
    };
  }
}
```

The mapper `toProductReadDto` lives in `application/dto/product-read.dto.ts` next to the interface — keeps the read shape colocated with its mapper.

## `get-product-by-slug.use-case.ts` shape

```ts
async execute(input: { slug: string }): Promise<ProductReadDto> {
  const product = await this.products.findBySlug(input.slug);
  if (!product || product.status === 'archived') throw new ProductNotFoundError(input.slug);
  return toProductReadDto(product);
}
```

The archived branch returns a not-found error — the buyer-facing browse path treats archived as nonexistent.

## `get-variant.use-case.ts` shape

```ts
async execute(input: { variantId: number }): Promise<VariantReadDto> {
  const result = await this.products.findVariantById(input.variantId);
  if (!result || result.product.status === 'archived') throw new VariantNotFoundError(input.variantId);
  return toVariantReadDto(result.variant, result.product);
}
```

## Files to add

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/list-active-products.use-case.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/get-product-by-slug.use-case.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/get-variant.use-case.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/list-active-products.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/get-product-by-slug.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/get-variant.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/dto/product-read.dto.ts` (interface + `toProductReadDto`).
- `apps/catalog-microservice/src/modules/catalog/application/dto/variant-read.dto.ts` (interface + `toVariantReadDto`).
- `apps/catalog-microservice/src/modules/catalog/application/dto/index.ts` (barrel).

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/application/ports/product.repository.port.ts` — add `findVariantById(variantId: number): Promise<{ product: Product; variant: ProductVariant } | null>`.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/product-typeorm.repository.ts` — implement `findVariantById` via a join.
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts` — add three read `@MessagePattern` handlers.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — register the three new use cases as providers.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/index.ts` — barrel re-export.
- `libs/messaging/routing-keys.constants.ts` — add the three RPC keys.
- `libs/cache/cache-keys.ts` — add the `productByVariantId(variantId, facet?)` builder + `CATALOG_PRODUCT_KEY_VERSION` constant.
- `docs/implementation/02-catalog-product-and-variant/04-catalog-use-cases.md` — replace the `<!-- task-05-read-path-anchor -->` with the read-path subsection. The doc is complete after this task.

## Files to delete

None.

## Tests

### `list-active-products.use-case.spec.ts`

- **Default pagination**: input `{}` → calls `findActiveProducts({ page: 1, pageSize: 20, search: undefined })`.
- **Clamping**: `{ page: 0 }` → `page: 1`; `{ pageSize: 1000 }` → `pageSize: 100`.
- **Search passthrough**: `{ search: 'red shirt' }` → propagated unchanged.
- **Archived variants filtered**: `findActiveProducts` returns a Product with one active + one archived variant; the read DTO contains only the active one.
- **Total count surfaced**: `findActiveProducts` returns `total=42`; the use case returns the same.

### `get-product-by-slug.use-case.spec.ts`

- **Happy path**: returns the read DTO.
- **Archived**: `findBySlug` returns an archived Product; throws `ProductNotFoundError`.
- **Missing**: `findBySlug` returns `null`; throws `ProductNotFoundError`.

### `get-variant.use-case.spec.ts`

- **Happy path**: returns the variant read DTO with `productSlug` + `productName` populated from the parent.
- **Parent archived**: throws `VariantNotFoundError`.
- **Missing**: throws `VariantNotFoundError`.

## Doc deliverable — `04-catalog-use-cases.md` (read-path subsection)

Replace the `<!-- task-05-read-path-anchor -->` placeholder with:

1. **`Query Catalog`.** Three RPC routing keys (`catalog.product.list`, `catalog.product.get`, `catalog.variant.get`); the buyer-facing nature — `@Public()` on the gateway side; pagination conventions (default 20, max 100; 1-indexed page).
2. **Read DTOs vs. domain aggregates.** Why `ProductReadDto`/`VariantReadDto` are flat plain interfaces rather than serialised aggregates: the read path skips invariant enforcement, hides archived variants, denormalises `productSlug`/`productName` onto the variant DTO for buyer-facing convenience, and crosses the RPC boundary as plain JSON.
3. **Archived rows in the read path.** Archived Products / Variants are filtered out of `list-active-products`, and `get-product-by-slug` / `get-variant` return a `not-found` rather than exposing the archived shape. The aggregate-level row remains forever — referenced by historical Orders — but the browse path treats it as deleted. Cross-Cutting "Soft delete vs hard delete" reference.
4. **No live cache today.** The cache-key builder is added (`productByVariantId(variantId, facet?)`) and `CATALOG_PRODUCT_KEY_VERSION = 'v1'` is registered. The wiring of a Redis cache-aside layer for catalog reads is left for a future epic — when it ships, the call sites under `application/use-cases/` will gain a `Cache.get → fallback → Cache.set` pattern (cf. `apps/inventory-microservice/.../stock.cache.ts` for the existing pattern). Today, every read hits MySQL.
5. **What this task did NOT do.** The api-gateway HTTP wrapper (task-06); the live cache.

## Carryover produced (consumed by task-06 onward)

- Three read use cases + three RPC routing keys are live.
- `catalog.controller.ts` has seven `@MessagePattern` handlers total (4 write + 3 read).
- `IProductRepositoryPort.findVariantById` is implemented.
- `libs/cache/cache-keys.ts` exposes `productByVariantId(...)` + `CATALOG_PRODUCT_KEY_VERSION` (currently unused; task-06 may consume the constant in its `Cache-Control` headers).
- Doc `04-catalog-use-cases.md` is complete (no remaining `<!-- task-… -->` anchors).

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the three new use-case specs are green.
- [ ] `yarn start:dev:catalog-microservice` boots; the seven `@MessagePattern` handlers are visible in startup logs.
- [ ] Manual RPC smoke: emitting `catalog.product.list` with `{ page: 1, pageSize: 10 }` returns a paged list response.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `04-catalog-use-cases.md` is complete (no remaining HTML-comment anchors).
