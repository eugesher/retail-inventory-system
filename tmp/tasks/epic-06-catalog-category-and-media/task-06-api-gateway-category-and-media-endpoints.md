---
epic: epic-06
task_number: 6
title: Add api-gateway category + media HTTP endpoints (controllers, DTOs, port methods, adapter, e2e)
depends_on: [epic-02, task-01, task-02, task-03, task-04, task-05]
doc_deliverable_primary: docs/implementation/06-catalog-category-and-media/05-category-and-media-api.md
---

# Task 06 — api-gateway category + media endpoints

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-009](../../../docs/adr/009-port-adapter-at-the-gateway.md) — `ClientProxy` only inside `infrastructure/messaging/*-rabbitmq.adapter.ts`; controllers/use-cases/pipes inject the port symbol.
  - [ADR-010](../../../docs/adr/010-jwt-rbac-at-the-gateway.md) / [ADR-024](../../../docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md) — every route protected by default; writes behind `@RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)`; reads opt out with `@Public()`.
  - [ADR-008](../../../docs/adr/008-rabbitmq-via-libs-messaging.md) — adapters use `ROUTING_KEYS.*` (the dotted constants added in tasks 02–04).

## Goal

Make the new catalog capabilities reachable over HTTP by **extending** the existing api-gateway `modules/catalog/` (from `epic-02`) with the 11 category + media endpoints from the epic's API Surface table. The gateway is a port-and-adapter façade (ADR-009): add port methods, the RMQ adapter implementations, thin gateway use cases, controller endpoints, request DTOs, and the two e2e specs.

## Entry state assumed

`epic-02` merged; tasks 01–05 carryover present:

- `apps/api-gateway/src/modules/catalog/` exists with `ICatalogGatewayPort` + `CATALOG_GATEWAY`, `CatalogRabbitmqAdapter`, the gateway use cases, `CatalogController` (product/variant endpoints), DTOs, and the module wiring importing `MicroserviceClientCatalogModule`.
- The catalog-microservice exposes the new `@MessagePattern` handlers + routing keys from tasks 02–04: `catalog.category.{create,reparent,browse}`, `catalog.product.{reclassify,detach-category}`, `catalog.media.{attach,reorder,detach,browse}`, plus whatever category list/tree read RPC is needed (see "Category list/tree read" below).
- `epic-01`: `PermissionsGuard`, `@RequiresPermission()`, `@Public()`, `PermissionCodeEnum.CATALOG_WRITE` available.

## Endpoints to add (epic API Surface table)

| Method | Path | Auth | Routing key (RPC) |
|---|---|---|---|
| `POST` | `/api/catalog/categories` | `CATALOG_WRITE` | `catalog.category.create` |
| `PATCH` | `/api/catalog/categories/:slug/parent` | `CATALOG_WRITE` | `catalog.category.reparent` |
| `GET` | `/api/catalog/categories?root=true\|false` | `@Public()` | `catalog.category.list` |
| `GET` | `/api/catalog/categories/:slug/tree` | `@Public()` | `catalog.category.tree` |
| `POST` | `/api/catalog/products/:productId/categories` | `CATALOG_WRITE` | `catalog.product.reclassify` |
| `DELETE` | `/api/catalog/products/:productId/categories/:categorySlug` | `CATALOG_WRITE` | `catalog.product.detach-category` |
| `GET` | `/api/catalog/categories/:slug/products?includeDescendants=&page=` | `@Public()` | `catalog.category.browse` |
| `POST` | `/api/catalog/media` | `CATALOG_WRITE` | `catalog.media.attach` |
| `PATCH` | `/api/catalog/media/reorder` | `CATALOG_WRITE` | `catalog.media.reorder` |
| `DELETE` | `/api/catalog/media/:id` | `CATALOG_WRITE` | `catalog.media.detach` |
| `GET` | `/api/catalog/products/:productId/media` | `@Public()` | `catalog.media.browse` (ownerType=product) |
| `GET` | `/api/catalog/variants/:variantId/media` | `@Public()` | `catalog.media.browse` (ownerType=product-variant) |

### Category list/tree read

`GET /api/catalog/categories` (flat list, `?root=true` → roots only) and `GET /api/catalog/categories/:slug/tree` (nested tree) need catalog-side read RPCs. If task-03 did not add `catalog.category.list` / `catalog.category.tree` handlers, add them now as thin reads (`findChildren(null)` / build a nested tree from `findDescendants(path)`), updating the catalog-microservice controller + `routing-keys.constants.ts`. Prefer adding them on the catalog side (a list/tree read belongs in the owning service); the gateway only forwards.

## Controller shape

Decide between extending the existing `CatalogController` or adding sibling controllers (`CategoryController`, `MediaController`) under the same `modules/catalog/presentation/`. Prefer **two new sibling controllers** to keep each file focused — both register in the gateway's catalog module. Each method injects a thin gateway use case (one per endpoint, delegating to a port method) and is gated per the table. Example:

```ts
@Controller('catalog/categories')
export class CategoryController {
  constructor(
    private readonly createCategory: CreateCategoryGatewayUseCase,
    private readonly reparentCategory: ReparentCategoryGatewayUseCase,
    private readonly listCategories: ListCategoriesGatewayUseCase,
    private readonly getTree: GetCategoryTreeGatewayUseCase,
    private readonly browse: BrowseByCategoryGatewayUseCase,
  ) {}

  @Post()
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  create(@Body() dto: CreateCategoryRequestDto, @CurrentUser() user: ICurrentUser): Promise<CategoryResponseDto> {
    return this.createCategory.execute({ ...dto, correlationId: user.correlationId });
  }

  @Patch(':slug/parent')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  reparent(@Param('slug') slug: string, @Body() dto: ReparentCategoryRequestDto, @CurrentUser() user: ICurrentUser): Promise<ReparentCategoryResponseDto> {
    return this.reparentCategory.execute({ slug, newParentSlug: dto.newParentSlug, correlationId: user.correlationId });
  }

  @Get()
  @Public()
  list(@Query('root') root?: string): Promise<CategoryResponseDto[]> {
    return this.listCategories.execute({ rootOnly: root === 'true' });
  }

  @Get(':slug/tree')
  @Public()
  tree(@Param('slug') slug: string): Promise<CategoryTreeResponseDto> {
    return this.getTree.execute({ slug });
  }

  @Get(':slug/products')
  @Public()
  browseProducts(@Param('slug') slug: string, @Query() q: BrowseProductsQueryDto): Promise<PagedProductsResponseDto> {
    return this.browse.execute({ slug, includeDescendants: q.includeDescendants, page: q.page, pageSize: q.pageSize });
  }
}
```

Verify `@CurrentUser()` / `ICurrentUser` + `correlationId` availability against `epic-02`'s catalog controller; if `correlationId` is not on `ICurrentUser`, use `@CorrelationId()` (per `epic-02`'s task-06 note). Reclassify-attach / detach live on a `products/:productId/categories` route — put them on whichever controller `epic-02` used for product writes, or a small `ProductCategoryController`; the media routes (`catalog/media`, `products/:id/media`, `variants/:id/media`) go on a `MediaController`.

## Port + adapter additions

Extend `ICatalogGatewayPort` with one method per new RPC (e.g. `createCategory`, `reparentCategory`, `listCategories`, `getCategoryTree`, `browseByCategory`, `reclassifyProduct`, `detachProductCategory`, `attachMedia`, `reorderMedia`, `detachMedia`, `browseMedia`). Implement each in `CatalogRabbitmqAdapter` as a single `firstValueFrom(this.client.send(ROUTING_KEYS.<KEY>, payload))` — the only place `ClientProxy` is touched (ADR-009).

## DTOs

Request DTOs (`class-validator`), gateway-only:

- `CreateCategoryRequestDto` — `name @IsString @MinLength(1)`; `slug @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)`; `parentSlug? @IsOptional @Matches(...)`.
- `ReparentCategoryRequestDto` — `newParentSlug? @IsOptional @Matches(...)` (omitted → demote to root).
- `BrowseProductsQueryDto` — `includeDescendants? @Type(() => Boolean) @IsBoolean @IsOptional`; `page?`/`pageSize?` as in `epic-02`'s list query.
- `ReclassifyProductRequestDto` — `categorySlugs @IsArray @ArrayNotEmpty @Matches(... , { each: true })`.
- `AttachMediaRequestDto` — `ownerType @IsEnum(MediaOwnerTypeEnum)`; `ownerId @IsInt @Min(1)`; `uri @IsString @Matches(/^(https:\/\/|s3:\/\/)/)`; `type @IsEnum(MediaTypeEnum)`; `altText? @IsString @MaxLength(255) @IsOptional`.
- `ReorderMediaRequestDto` — `ownerType`, `ownerId`, `mediaIdsInOrder @IsArray @ArrayNotEmpty @IsInt({ each: true })`.

Response DTOs mirror the catalog-microservice views; prefer sharing through `libs/contracts/catalog/` (extend the barrel `epic-02` created). The publish response DTO already carries `warnings: string[]` (task-05) — no gateway change beyond forwarding it.

## Files to add

- Gateway use cases under `apps/api-gateway/src/modules/catalog/application/use-cases/` — one per endpoint (thin delegators).
- `apps/api-gateway/src/modules/catalog/presentation/category.controller.ts`, `media.controller.ts` (+ a product-category controller if not folding into `epic-02`'s product controller).
- Request DTOs under `apps/api-gateway/src/modules/catalog/presentation/dto/`.
- Shared response DTOs under `libs/contracts/catalog/` (category, category-tree, media-asset, paged-products-by-category) + barrel extension.
- `test/catalog-categories.e2e-spec.ts`, `test/catalog-media.e2e-spec.ts`.
- `docs/implementation/06-catalog-category-and-media/05-category-and-media-api.md`.

## Files to modify

- `apps/api-gateway/src/modules/catalog/application/ports/catalog-gateway.port.ts` — add the new methods.
- `apps/api-gateway/src/modules/catalog/infrastructure/messaging/catalog-rabbitmq.adapter.ts` — implement them.
- `apps/api-gateway/src/modules/catalog/infrastructure/catalog.module.ts` — register the new controllers + use cases.

## Files to delete

None.

## Tests

### `test/catalog-categories.e2e-spec.ts` (mirrors the epic's Test Strategy)

1. Admin creates a root + two children + one grandchild; assert `path` values (`/electronics`, `/electronics/phones`, …).
2. Reparent one grandchild under a different root → response reports `descendantsRewritten`; subtree paths re-fetched and verified.
3. Reclassify a seeded product into two categories → it appears under both `GET …/:slug/products` endpoints.
4. Cycle reparent (a node under its own descendant) → `409`.
5. Permission: a StaffUser without `catalog:write` → `403` on `POST /categories`; unauthenticated `GET /categories` → `200`.

### `test/catalog-media.e2e-spec.ts`

1. Admin attaches three media to a product in a given order → `sortOrder` 0,1,2.
2. Reorder them → `GET /products/:id/media` reflects the new order.
3. Detach one → browse returns the other two in post-detach order.
4. Permission: non-`catalog:write` StaffUser → `403` on `POST /media`; unauthenticated browse → `200`.

If the `catalog-manager` seed (task-08) is not yet present, gate the permission-failure cases with `xit` + a `TODO(task-08)` comment; task-08 flips them to `it`.

## Doc deliverable — `05-category-and-media-api.md`

Target ~150 lines. Sections:

1. **Why the gateway extends `modules/catalog/`.** ADR-009 façade; new endpoints reuse the existing port + adapter rather than a new module.
2. **The 11 endpoints + permission gates.** The table above, with rationale: writes are `catalog:write`; reads are `@Public()` (buyer-facing browse). Reparent returns `descendantsRewritten` for admin feedback.
3. **The `includeDescendants` knob.** How browse maps to a path-prefix scan on the catalog side; default (false) returns only direct members.
4. **Polymorphic media routes.** Why `products/:id/media` and `variants/:id/media` both proxy `catalog.media.browse` with different `ownerType`s; `POST /media` takes `ownerType` in the body.
5. **RPC error mapping.** `CategoryCycleError` → `409`; `CategoryNotFoundError`/`MediaAssetNotFoundError` → `404`; `DuplicateCategorySlugError` → `409` (reuse `epic-02`'s domain-error → HTTP mapping; flag any gap as a TODO).
6. **What this task did NOT do.** The HTTP files (task-07); the seed (task-08).

## Carryover produced (consumed by task-07 / task-08)

- All 11 endpoints reachable; admin bearer drives category + media writes; public bearer browses.
- e2e specs present (permission-failure cases possibly `xit` pending task-08 seed).
- `libs/contracts/catalog/` carries the new response shapes.
- `05-category-and-media-api.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); `ClientProxy` appears only in the adapter (boundaries clean).
- [ ] `yarn test:e2e` passes for the enabled blocks; any `xit` block has a `TODO(task-08)` comment.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots; `curl http://localhost:3000/api/catalog/categories` returns `200` (empty list against an empty DB).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] `05-category-and-media-api.md` exists with the sections above.
