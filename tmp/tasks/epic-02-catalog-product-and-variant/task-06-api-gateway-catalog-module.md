---
epic: epic-02
task_number: 6
title: Add the api-gateway modules/catalog/ module — port, RMQ adapter, use cases, controller, DTOs, pipes
depends_on: [task-01, task-02, task-03, task-04, task-05]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/06-api-gateway-catalog-module.md
---

# Task 06 — `apps/api-gateway/src/modules/catalog/` module

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Wire the buyer-facing and admin-facing HTTP surface for the catalog. Add the gateway's `modules/catalog/` per-module hexagonal tree, mirroring the existing shapes of `apps/api-gateway/src/modules/retail/` and `apps/api-gateway/src/modules/inventory/`. The controller exposes the seven HTTP endpoints listed in the epic's API Surface table; the messaging adapter RPCs into the catalog-microservice using the seven `@MessagePattern` handlers introduced by tasks 03–05.

This task is where the catalog finally becomes reachable from outside the cluster. Until this task ships, the catalog-microservice only responds to direct RabbitMQ RPCs.

## Entry state assumed

Tasks 1–5 carryover present:

- `catalog-microservice` exposes seven `@MessagePattern` handlers: four write commands (`catalog.product.register`, `catalog.variant.add`, `catalog.product.publish`, `catalog.product.archive`) and three reads (`catalog.product.list`, `catalog.product.get`, `catalog.variant.get`).
- `MicroserviceClientCatalogModule` exports a `ClientProxy` bound to `catalog_queue`.
- `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE` is defined.
- `epic-01` is merged: `PermissionsGuard` is global; `@RequiresPermission()`, `@Public()`, and the seeded permission codes (`catalog:read`, `catalog:write`, `catalog:publish`) are available.

## Scope

**In:**

- A new `apps/api-gateway/src/modules/catalog/` tree mirroring the existing `retail/` and `inventory/` shapes (verified by inspecting both):
  - `application/ports/catalog-gateway.port.ts` — `ICatalogGatewayPort` (the RPC client port).
  - `application/use-cases/` — one use case per HTTP endpoint, each delegating to the port.
  - `infrastructure/messaging/catalog-rabbitmq.adapter.ts` — implements the port by emitting RPC messages to `catalog_queue`.
  - `infrastructure/catalog.module.ts` — wires DI, imports `MicroserviceClientCatalogModule`.
  - `presentation/catalog.controller.ts` — the public-facing controller with the seven endpoints.
  - `presentation/dto/` — request DTOs with `class-validator` decorators; response DTOs (re-exports of the read DTOs from the catalog-microservice contract via `libs/contracts/`).
  - `presentation/pipes/` — body/query pipes where parsing/transformation is needed (e.g. the list-query pipe parses `?page=` and `?pageSize=` to numbers).
- Permission gating per the epic's API Surface table:
  - `POST /api/catalog/products` → `@RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)`.
  - `POST /api/catalog/products/:productId/variants` → `CATALOG_WRITE`.
  - `POST /api/catalog/products/:productId/publish` → `CATALOG_PUBLISH`.
  - `POST /api/catalog/products/:productId/archive` → `CATALOG_WRITE`.
  - `GET /api/catalog/products` → `@Public()`.
  - `GET /api/catalog/products/:slug` → `@Public()`.
  - `GET /api/catalog/variants/:variantId` → `@Public()`.
- An e2e spec `test/catalog.e2e-spec.ts` exercising the full flow described in the epic's Test Strategy (admin registers → adds variants → publishes → customer queries → admin archives → permission-failure cases).
- Doc deliverable `06-api-gateway-catalog-module.md`.

**Out:**

- The seeded admin user / customer-manager role bindings — `epic-01` (task-09 of `epic-01` seeds the admin; task-09 of this epic extends the seed for `catalog-manager`).
- The HTTP request file `http/catalog.http` — task-07.
- Any catalog-microservice changes — they're complete by task-05.

## Controller shape (`presentation/catalog.controller.ts`)

```ts
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly registerProduct: RegisterProductGatewayUseCase,
    private readonly addVariant: AddVariantGatewayUseCase,
    private readonly publishProduct: PublishProductGatewayUseCase,
    private readonly archiveProduct: ArchiveProductGatewayUseCase,
    private readonly listProducts: ListProductsGatewayUseCase,
    private readonly getProductBySlug: GetProductBySlugGatewayUseCase,
    private readonly getVariant: GetVariantGatewayUseCase,
  ) {}

  @Post('products')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  registerProductHandler(@Body() dto: RegisterProductRequestDto, @CurrentUser() user: ICurrentUser): Promise<ProductResponseDto> {
    return this.registerProduct.execute({ ...dto, correlationId: user.correlationId });
  }

  @Post('products/:productId/variants')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  addVariantHandler(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() dto: AddVariantRequestDto,
    @CurrentUser() user: ICurrentUser,
  ): Promise<VariantResponseDto> {
    return this.addVariant.execute({ productId, ...dto, correlationId: user.correlationId });
  }

  @Post('products/:productId/publish')
  @RequiresPermission(PermissionCodeEnum.CATALOG_PUBLISH)
  publishProductHandler(@Param('productId', ParseIntPipe) productId: number, @CurrentUser() user: ICurrentUser): Promise<ProductResponseDto> {
    return this.publishProduct.execute({ productId, correlationId: user.correlationId });
  }

  @Post('products/:productId/archive')
  @RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)
  archiveProductHandler(@Param('productId', ParseIntPipe) productId: number, @CurrentUser() user: ICurrentUser): Promise<ProductResponseDto> {
    return this.archiveProduct.execute({ productId, correlationId: user.correlationId });
  }

  @Get('products')
  @Public()
  listProductsHandler(@Query() query: ListProductsQueryDto): Promise<PagedProductsResponseDto> {
    return this.listProducts.execute(query);
  }

  @Get('products/:slug')
  @Public()
  getProductBySlugHandler(@Param('slug') slug: string): Promise<ProductResponseDto> {
    return this.getProductBySlug.execute({ slug });
  }

  @Get('variants/:variantId')
  @Public()
  getVariantHandler(@Param('variantId', ParseIntPipe) variantId: number): Promise<VariantResponseDto> {
    return this.getVariant.execute({ variantId });
  }
}
```

Exact `@CurrentUser()` / `ICurrentUser` API names: verify against the existing `auth-admin.controller.ts` (epic-01). If `correlationId` is not currently on `ICurrentUser`, inject it via the request scope using `@CorrelationId()` instead.

## Port shape (`application/ports/catalog-gateway.port.ts`)

```ts
export const CATALOG_GATEWAY = Symbol('CATALOG_GATEWAY');

export interface ICatalogGatewayPort {
  registerProduct(input: { name: string; slug: string; description?: string; correlationId: string }): Promise<ProductResponseDto>;
  addVariant(input: { productId: number; sku: string; gtin?: string; optionValues: Record<string, string>; weightG?: number; dimensionsMm?: { l: number; w: number; h: number }; correlationId: string }): Promise<VariantResponseDto>;
  publishProduct(input: { productId: number; correlationId: string }): Promise<ProductResponseDto>;
  archiveProduct(input: { productId: number; correlationId: string }): Promise<ProductResponseDto>;
  listProducts(input: { page?: number; pageSize?: number; search?: string }): Promise<PagedProductsResponseDto>;
  getProductBySlug(input: { slug: string }): Promise<ProductResponseDto>;
  getVariant(input: { variantId: number }): Promise<VariantResponseDto>;
}
```

The seven gateway-side use cases each have a one-line `execute` that delegates to the corresponding port method — they exist purely to keep the controller decoupled from `ICatalogGatewayPort` and to be the place to add cross-cutting decorations (audit-log calls, metrics) later. This mirrors the existing `retail/` and `inventory/` module shapes.

## Adapter shape (`infrastructure/messaging/catalog-rabbitmq.adapter.ts`)

```ts
@Injectable()
export class CatalogRabbitmqAdapter implements ICatalogGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE) private readonly client: ClientProxy,
  ) {}

  registerProduct(input) {
    return firstValueFrom(this.client.send(ROUTING_KEYS.CATALOG_PRODUCT_REGISTER, input));
  }
  // ... one method per RPC.
}
```

Cross-check: in task-03, the catalog-microservice's `@MessagePattern` for register is bound to the routing key `'catalog.product.register'`. That constant needs to be added to `libs/messaging/routing-keys.constants.ts` if it isn't already (task-03's scope mentioned the controller handlers but not the constant — verify and add the constant here if missing). Same for `catalog.variant.add`. The list/get/publish/archive constants exist from tasks 04–05.

## DTOs (`presentation/dto/`)

Request DTOs use `class-validator`:

- `RegisterProductRequestDto` — `name: @IsString @MinLength(1) @MaxLength(255)`; `slug: @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(200)`; `description?: @IsString @MaxLength(2000) @IsOptional`.
- `AddVariantRequestDto` — `sku: @Matches(/^[A-Za-z0-9][A-Za-z0-9-_]*$/) @MaxLength(64)`; `gtin?: @Matches(/^\d{8,14}$/) @IsOptional`; `optionValues: @IsObject @IsNotEmptyObject`; `weightG?: @IsInt @Min(0) @IsOptional`; `dimensionsMm?: nested @ValidateNested + @Type(() => DimensionsDto)`.
- `ListProductsQueryDto` — `page?: @IsInt @Min(1) @Type(() => Number)`; `pageSize?: @IsInt @Min(1) @Max(100) @Type(() => Number)`; `search?: @IsString @MaxLength(200)`.

Response DTOs are plain interfaces (or class-with-no-decorators) that mirror the read DTOs from the catalog-microservice. **Prefer importing them from `libs/contracts/catalog/`** — if that module doesn't exist yet, add it as part of this task and have both the catalog-microservice's read DTOs and the gateway's response DTOs reference the same `libs/contracts/catalog/product-response.dto.ts`.

## Files to add

- `apps/api-gateway/src/modules/catalog/index.ts` (barrel).
- `apps/api-gateway/src/modules/catalog/application/ports/catalog-gateway.port.ts` (port + token).
- `apps/api-gateway/src/modules/catalog/application/ports/index.ts`.
- `apps/api-gateway/src/modules/catalog/application/use-cases/register-product.use-case.ts`.
- `apps/api-gateway/src/modules/catalog/application/use-cases/add-variant.use-case.ts`.
- `apps/api-gateway/src/modules/catalog/application/use-cases/publish-product.use-case.ts`.
- `apps/api-gateway/src/modules/catalog/application/use-cases/archive-product.use-case.ts`.
- `apps/api-gateway/src/modules/catalog/application/use-cases/list-products.use-case.ts`.
- `apps/api-gateway/src/modules/catalog/application/use-cases/get-product-by-slug.use-case.ts`.
- `apps/api-gateway/src/modules/catalog/application/use-cases/get-variant.use-case.ts`.
- `apps/api-gateway/src/modules/catalog/application/use-cases/index.ts` (barrel).
- `apps/api-gateway/src/modules/catalog/infrastructure/catalog.module.ts`.
- `apps/api-gateway/src/modules/catalog/infrastructure/messaging/catalog-rabbitmq.adapter.ts`.
- `apps/api-gateway/src/modules/catalog/presentation/catalog.controller.ts`.
- `apps/api-gateway/src/modules/catalog/presentation/dto/register-product-request.dto.ts`.
- `apps/api-gateway/src/modules/catalog/presentation/dto/add-variant-request.dto.ts`.
- `apps/api-gateway/src/modules/catalog/presentation/dto/list-products-query.dto.ts`.
- `apps/api-gateway/src/modules/catalog/presentation/dto/dimensions.dto.ts`.
- `apps/api-gateway/src/modules/catalog/presentation/dto/index.ts` (barrel).
- `apps/api-gateway/src/modules/catalog/presentation/pipes/` — only if a custom pipe is needed beyond the built-in `ParseIntPipe`; otherwise omit.
- `libs/contracts/catalog/product-response.dto.ts` (shared between gateway and microservice).
- `libs/contracts/catalog/variant-response.dto.ts`.
- `libs/contracts/catalog/paged-products-response.dto.ts`.
- `libs/contracts/catalog/index.ts` (barrel) + extend `libs/contracts/index.ts`.
- `test/catalog.e2e-spec.ts`.
- `docs/implementation/02-catalog-product-and-variant/06-api-gateway-catalog-module.md`.

## Files to modify

- `apps/api-gateway/src/app/app.module.ts` — register the new `CatalogModule` (or `CatalogGatewayModule` if naming collisions with the catalog-microservice's own `CatalogModule` are a problem — both modules can share the same class name across apps without conflict, but the imports in `app.module.ts` will look identical to the existing `RetailModule`/`InventoryModule` patterns).
- `libs/messaging/routing-keys.constants.ts` — add `CATALOG_PRODUCT_REGISTER = 'catalog.product.register'` and `CATALOG_VARIANT_ADD = 'catalog.variant.add'` if missing (task-03's `@MessagePattern` strings imply the constants; this task ensures they're typed).
- Possibly the existing `apps/catalog-microservice/.../catalog.controller.ts` to switch from string literals to `ROUTING_KEYS.CATALOG_PRODUCT_REGISTER` etc. — verify task-03's wording; if it already uses the constants, no change here.

## Files to delete

None.

## Tests

### `test/catalog.e2e-spec.ts`

Full flow (one `describe`, sequential `it`s sharing state):

1. **Admin registers a Product.** `POST /api/catalog/products` with the seeded admin bearer; expect 201 + `status: 'draft'`. Save `productId`.
2. **Admin adds two Variants.** Two `POST /api/catalog/products/:productId/variants` calls with distinct SKUs; expect 201 each. Save the `variantId`s.
3. **Admin publishes the Product.** `POST /api/catalog/products/:productId/publish`; expect 200 + `status: 'active'` + `publishedAt`.
4. **Customer queries `/api/catalog/products`.** No auth; expect 200 + the new Product in the list with both Variants.
5. **Customer queries `/api/catalog/products/:slug`.** Expect 200 + the full Product shape.
6. **Customer queries `/api/catalog/variants/:variantId`.** Expect 200 + variant + parent header.
7. **Admin archives the Product.** `POST /api/catalog/products/:productId/archive`; expect 200 + `status: 'archived'`.
8. **Customer queries again** and the Product no longer appears in the default (`status=active`) filter.

Permission tests (separate `describe`):

- A StaffUser without `catalog:write` gets 403 on `POST /api/catalog/products`.
- A StaffUser without `catalog:publish` gets 403 on `POST .../publish`.
- A StaffUser without `catalog:write` gets 403 on `POST .../archive`.
- An unauthenticated request gets 200 on `GET /api/catalog/products`.

The e2e file relies on the seeded `catalog-manager` role + a non-catalog StaffUser. The seed extension that adds these is task-09's scope; until task-09 lands, the permission-failure cases use the existing `epic-01` seed and `xit` (or `it.skip`) the catalog-manager-specific cases. **Track this as a known temporary gap; task-09 flips the `xit` → `it`.**

## Doc deliverable

Write `docs/implementation/02-catalog-product-and-variant/06-api-gateway-catalog-module.md`. Target ~150 lines. Sections:

1. **Why the api-gateway has its own `modules/catalog/`.** ADR-009: the gateway is a port-and-adapter façade — its own use cases, ports, and adapters wrap the downstream microservice. This is symmetrical with `retail/` (orders) and `inventory/` (product-stock).
2. **The seven endpoints and their permission gates.** Table from the epic, with one-line rationale per gate: registration + variant addition are catalog admin work (`catalog:write`); publication is a higher-privilege gate (`catalog:publish`) because mistakes go to buyers; reads are `@Public()` because Query Catalog is a buyer-facing browse path.
3. **Why archive is `catalog:write`, not `catalog:publish`.** Archival is a remediation path (a wrong publication can be archived by any catalog editor); reserving it for publishers would slow down corrections. Cross-Cutting "Soft delete vs hard delete" reference.
4. **The RPC adapter shape.** One `client.send(routingKey, payload)` per port method; `firstValueFrom` to bridge Observable → Promise; how RPC errors propagate (the catalog-microservice's typed domain errors are serialised as `{ name, message }` and the gateway's exception filter maps them — `DuplicateSlugError` → 409, `ProductHasNoVariantsError` → 422, etc. Cross-cutting "Domain-error mapping" reference if it exists; otherwise flag as a TODO and just let the default `RpcException` mapping handle it for this epic).
5. **DTO duplication and `libs/contracts/catalog/`.** Response shapes are shared between gateway and microservice via `libs/contracts/catalog/`; request shapes (with `class-validator`) are gateway-only because the catalog-microservice doesn't accept HTTP — its RPC schemas are validated by the controller-side DTO before the call.
6. **What this task did NOT do.** The HTTP file (`http/catalog.http` — task-07), the seed for `catalog-manager` and a non-catalog test user (task-09), the live read-path cache (future epic).

## Carryover produced (consumed by task-07 onward)

- All seven HTTP endpoints are reachable; an admin bearer can drive the full register → variants → publish → archive cycle; a public bearer can browse.
- The e2e spec is present (some permission-failure tests are `xit`-marked pending task-09's seed extension).
- `libs/contracts/catalog/` exists with the shared response shapes.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes (no new unit tests beyond what already exists in the catalog-microservice; the gateway use cases are too thin to spec).
- [ ] `yarn test:e2e` passes for `test/catalog.e2e-spec.ts`'s currently-enabled blocks; the `xit`-marked blocks have a clear `TODO(task-09)` comment.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev:api-gateway && yarn start:dev:catalog-microservice` boots both apps; `curl http://localhost:3000/api/catalog/products` returns `200 {"rows": [], "total": 0, "page": 1, "pageSize": 20}` against an empty DB.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `06-api-gateway-catalog-module.md` exists at the path above and is filled per the section list.
