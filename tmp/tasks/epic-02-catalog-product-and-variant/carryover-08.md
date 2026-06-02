# Carryover 08 → task-09

Task-08 ("API-gateway catalog module") is complete. This note is the entry state
for task-09 (the Kulala `http/catalog.http` file).

## Entry state for task-09

- The API gateway now **exposes all seven catalog RPCs over HTTP** at
  `/api/catalog` via a new `apps/api-gateway/src/modules/catalog/` module,
  registered in the gateway `AppModule`. The catalog microservice is unchanged
  (no new RPCs/contracts — all already existed).
- All gates green on a fresh run: `yarn lint` (exit 0, `--max-warnings 0`),
  `yarn test:unit` (**371 passed**, 55 suites — unchanged; gateway modules are
  covered by e2e, not unit, matching `inventory/`+`retail/`), `yarn build`
  (5 apps), `yarn test:e2e` (**6 suites / 67 tests / 38 snapshots** — was
  5/55/38; +1 suite `catalog.e2e-spec.ts`, +12 tests), self-containment grep
  clean.

## The gateway `modules/catalog/` surface

```
apps/api-gateway/src/modules/catalog/
  application/
    ports/catalog-gateway.port.ts   # ICatalogGatewayPort + CATALOG_GATEWAY_PORT
    use-cases/                       # 7 thin use cases (see below)
  infrastructure/
    messaging/catalog-rabbitmq.adapter.ts   # CatalogRabbitmqAdapter — ONLY ClientProxy holder
  presentation/
    catalog.controller.ts            # the 7 HTTP routes
    dto/                             # 3 request/query DTOs (class-validator)
  catalog.module.ts                  # binds CATALOG_GATEWAY_PORT -> CatalogRabbitmqAdapter
  index.ts                           # export * from './catalog.module'
```

- **Port symbol:** `CATALOG_GATEWAY_PORT = Symbol('CATALOG_GATEWAY_PORT')`.
  `ICatalogGatewayPort` declares the seven methods; inputs are
  **business-shaped command/query interfaces** (`IRegisterProductCommand`,
  `ICreateVariantCommand`, `IListProductsCommand`) that omit `correlationId`
  (the adapter stitches it on); responses are the catalog wire view DTOs from
  `@retail-inventory-system/contracts` (`ProductView`, `ProductVariantView`,
  `ProductWithVariantsView`, `VariantWithProductView`,
  `IPage<ProductWithVariantsView>`).
- **Adapter:** `CatalogRabbitmqAdapter` injects the `CATALOG_MICROSERVICE`
  `ClientProxy` (via `@Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE)`)
  and calls `firstValueFrom(client.send(ROUTING_KEYS.CATALOG_*, { ...payload,
  correlationId }))`. The only `ClientProxy` site in the module (ADR-009 / 020
  boundary green).
- **Module wiring:** `catalog.module.ts` imports `MicroserviceClientCatalogModule`
  from `@retail-inventory-system/messaging`, registers the seven use cases as
  providers, and binds `{ provide: CATALOG_GATEWAY_PORT, useClass:
  CatalogRabbitmqAdapter }`. `app/app.module.ts` adds `CatalogModule` to its
  `imports`.

### The seven use cases (`application/use-cases/`)

Each mirrors the inventory `GetProductStockUseCase`: inject `CATALOG_GATEWAY_PORT`
+ `PinoLogger`, `logger.assign({ correlationId })`, call the port inside a
`try`, and funnel failures through `throwRpcError` (`common/utils`).

| File | Class | Port call |
|---|---|---|
| `register-product.use-case.ts` | `RegisterProductUseCase` | `registerProduct(command, cid)` |
| `add-variant.use-case.ts` | `AddVariantUseCase` | `createVariant(command, cid)` |
| `publish-product.use-case.ts` | `PublishProductUseCase` | `publishProduct(productId, cid)` |
| `archive-product.use-case.ts` | `ArchiveProductUseCase` | `archiveProduct(productId, cid)` |
| `list-products.use-case.ts` | `ListProductsUseCase` | `listProducts(query, cid)` |
| `get-product.use-case.ts` | `GetProductUseCase` | `getProductBySlug(slug, cid)` |
| `get-variant.use-case.ts` | `GetVariantUseCase` | `getVariant(variantId, cid)` |

(The gateway use-case class names intentionally collide with the catalog
microservice's use-case names — different modules, no conflict.)

### The seven HTTP routes (`presentation/catalog.controller.ts`, `@Controller('catalog')` → `/api/catalog`)

| Method | Path | Auth | Status | Response |
|---|---|---|---|---|
| `POST` | `/products` | `@RequiresPermission(CATALOG_WRITE)` | 201 | `ProductView` (`draft`) |
| `POST` | `/products/:productId/variants` | `@RequiresPermission(CATALOG_WRITE)` | 201 | `ProductVariantView` |
| `POST` | `/products/:productId/publish` | `@RequiresPermission(CATALOG_PUBLISH)` | 200 | `ProductView` (`active`, `publishedAt`) |
| `POST` | `/products/:productId/archive` | `@RequiresPermission(CATALOG_WRITE)` | 200 | `ProductView` (`archived`, `archivedAt`) |
| `GET` | `/products` | `@Public()` | 200 | `IPage<ProductWithVariantsView>` |
| `GET` | `/products/:slug` | `@Public()` | 200 | `ProductWithVariantsView` |
| `GET` | `/variants/:variantId` | `@Public()` | 200 | `VariantWithProductView` |

- `:productId` / `:variantId` parse via `ParseIntPipe`. `add-variant` merges the
  route `productId` into the body command (`{ ...dto, productId }`).
- Permission codes come from `PermissionCodeEnum` (`@retail-inventory-system/contracts`);
  `Public` / `RequiresPermission` from `@retail-inventory-system/auth`.
- **Request DTOs** (`presentation/dto/`): `RegisterProductRequestDto`
  (`name`/`slug` kebab-regex/`description?`), `CreateVariantRequestDto`
  (`sku`/`gtin?`/`optionValues`/`weightG?`/`dimensionsMm?` nested VO),
  `ListProductsQueryDto` (`status?`/`page?`/`pageSize?`/`search?`, numbers coerced
  via `@Type(() => Number)`). The page-size cap is owned downstream (the
  microservice caps at 100); the DTO only enforces the positive-int floor.

## Key decisions & deviations (task-09 must respect)

- **`catalog.module.ts` lives at the module root**, not under `infrastructure/`.
  The task's ASCII layout drew it under `infrastructure/`, but **all four
  existing gateway modules** (`auth`, `inventory`, `retail`, `iam`) put their
  `*.module.ts` at the module root, and the task body says "mirror the existing
  inventory/ and retail/ gateway modules." Root placement keeps all five gateway
  modules uniform. (Note: the CLAUDE.md / README gateway *trees* historically
  draw gateway module files under `infrastructure/` — that depiction is
  schematic and does not match the real file locations; the new catalog tree
  entries show the accurate root location.)
- **Error mapping is forward-compatible but not yet precise — documented gap.**
  The gateway use cases call `throwRpcError`, which maps an `RpcException({
  statusCode })` to 404/400. **But the catalog microservice throws
  `CatalogDomainException` (a plain `DomainException`, not an `RpcException`)**,
  and NestJS's RMQ transport flattens any non-`RpcException` to `{ status:
  'error', message: 'Internal server error' }` — so the typed
  `CatalogErrorCodeEnum` does **not** survive the wire and a domain rejection
  (duplicate slug, publish-without-variant, etc.) currently surfaces as **500**
  at the gateway. The required e2e flow + permission tests don't hit a domain
  rejection, so all gates pass. Making it precise (`PRODUCT_NOT_FOUND`→404,
  `*_TAKEN`→409, invariant/transition→400) requires the **catalog microservice**
  to raise a structured `RpcException` carrying the status (the pattern retail's
  `OrderConfirmPipe` already uses) — that is a catalog-microservice change,
  explicitly out of task-08's scope. `throwRpcError` was left unchanged (it only
  handles 404/400 today; it does not yet map 409 — moot until the microservice
  serializes a status). **This is the one real follow-up worth flagging** for any
  later catalog-error-mapping work; it is not owned by tasks 09–10.
- **`throwRpcError` is shared** (`apps/api-gateway/src/common/utils`) with the
  retail/inventory gateway use cases — reused as-is, not modified.
- **App alias added for the catalog microservice** so the e2e can boot it:
  `@retail-inventory-system/apps/catalog-microservice` →
  `apps/catalog-microservice/src/app/app.module`, added to **`tsconfig.json`**
  (`paths`) and **`jest.e2e.config.js`** (`moduleNameMapper`), mirroring the
  other four app aliases. (Not in the task's "Files to modify" list — a small
  justified addition; the e2e cannot import the catalog `AppModule` without it.)

## The e2e spec + seeded users

- **`test/catalog.e2e-spec.ts`** boots the **catalog microservice**
  (`CATALOG_QUEUE`) + the **API gateway** in process (no retail/inventory needed
  for the catalog flow). Models on `test/iam.e2e-spec.ts`.
- **Seeded users it relies on** (`scripts/test-db-seed.ts`):
  - `admin@example.com` / `admin1234` — role `admin`, every permission (incl.
    `catalog:write` + `catalog:publish`). Drives the register→…→archive arc.
  - `warehouse@example.com` / `warehouse1234` — role `warehouse-staff`,
    `inventory:*` only (**no** catalog codes). The negative fixture: 403 on
    register and on publish.
  - Reads are anonymous (no token), so no customer login is needed.
- Idempotent under `yarn test:e2e:run` against a dirty DB: the product
  slug/name/SKUs are `Date.now()`-stamped, and the browse assertions filter via
  `?search=<stamp>` (the microservice's `listActive` matches
  `name LIKE %search% OR slug LIKE %search%`).
- Login is `POST /api/auth/login` (the deprecated staff-login alias the other
  e2e specs use).

## Known gaps (owned by later tasks)

- **Kulala `http/catalog.http`** — the seven gateway endpoints as `.http`
  requests with a `# Prereqs:` staff-login token capture (`@accessToken`), one
  `# @name` per request, header comments citing the controller path + body/query
  shape. **task-09.** No `tmp/`/epic/task references (§6). The public GETs need
  no token; the four POSTs need a bearer with `catalog:write` / `catalog:publish`
  (log in as `admin@example.com` or `catalog@example.com`).
- **Seed of standing products + docs finalization** — the catalog seed in
  `scripts/test-db-seed.ts` (currently no catalog rows — the tables are empty
  after a reload), the CLAUDE.md ADR "next free number" bump (still stale at
  "025" — ADR-025 is committed, should read "026"), and a consolidated catalog
  domain section. **task-10.** (Task-08 only updated the CLAUDE.md/README
  statements its own change made false: the two "gateway HTTP surface arrives in
  later work" sentences, the API-Gateway app tree, the README system-diagram box,
  the README gateway-layout tree, the README API route list, and the
  public-routes sentence. The stale `catalog-microservice` app-tree one-liner in
  CLAUDE.md — "domain + persistence + register/add-variant write use cases &
  events" — was left for task-10's consolidated catalog section.)
- **Precise catalog error→HTTP mapping** — see the deviation above. Requires a
  catalog-microservice change (structured `RpcException`); not tasks 09–10.
- **Pricing capability** — the deferred "≥1 active Price" publish precondition is
  still a warn-not-block seam in the microservice's `publish-product.use-case.ts`.
  Not tasks 08–10.
- **`product_id` → `variantId` reshape** in inventory/retail — later
  cross-context work, not tasks 08–10.

## Docs written vs pending

- **`docs/implementation/02-catalog-product-and-variant/07-api-gateway-catalog-module.md`**
  — written: §1 module shape (mirror retail/inventory, no `domain/`), §2 the
  `ClientProxy`-in-adapter-only boundary + the command/correlationId split, §3
  the seven-endpoint table (incl. the 200-vs-201 rationale), §4 permission gating
  + why customer tokens can't write, §5 edge validation, §6 error propagation
  (incl. the RMQ-flattening 500 note), §7 verification. Cross-links ADR-008/009/
  010/017/024/025.
- Docs 05 / 06 unchanged (complete from tasks 06/07).

## Files added

- `apps/api-gateway/src/modules/catalog/application/ports/catalog-gateway.port.ts`
- `apps/api-gateway/src/modules/catalog/application/ports/index.ts`
- `apps/api-gateway/src/modules/catalog/application/use-cases/{register-product,add-variant,publish-product,archive-product,list-products,get-product,get-variant}.use-case.ts`
- `apps/api-gateway/src/modules/catalog/application/use-cases/index.ts`
- `apps/api-gateway/src/modules/catalog/infrastructure/messaging/catalog-rabbitmq.adapter.ts`
- `apps/api-gateway/src/modules/catalog/infrastructure/messaging/index.ts`
- `apps/api-gateway/src/modules/catalog/presentation/catalog.controller.ts`
- `apps/api-gateway/src/modules/catalog/presentation/index.ts`
- `apps/api-gateway/src/modules/catalog/presentation/dto/{register-product.request,create-variant.request,list-products.query}.dto.ts`
- `apps/api-gateway/src/modules/catalog/presentation/dto/index.ts`
- `apps/api-gateway/src/modules/catalog/catalog.module.ts`
- `apps/api-gateway/src/modules/catalog/index.ts`
- `test/catalog.e2e-spec.ts`
- `docs/implementation/02-catalog-product-and-variant/07-api-gateway-catalog-module.md`

## Files modified

- `apps/api-gateway/src/app/app.module.ts` — imports + registers `CatalogModule`.
- `tsconfig.json` — `@retail-inventory-system/apps/catalog-microservice` path.
- `jest.e2e.config.js` — same alias in `moduleNameMapper`.
- `CLAUDE.md` — architecture intro + catalog service section (the two "gateway
  HTTP surface arrives in later work" sentences replaced), API-Gateway app tree
  (added `catalog/`).
- `README.md` — system-diagram box (Catalog routes), gateway-layout tree
  (`catalog/` subtree + inventory reflowed to a middle child), API route list
  (`### Catalog`), public-routes sentence.

## Files deleted

- None.

## How to verify

```bash
yarn lint                 # --max-warnings 0, exit 0
yarn test:unit            # 371 passed, 55 suites (unchanged)
yarn build                # 5 apps compile

# Full regression (infra reload → migrate → seed → all e2e incl. catalog):
yarn test:e2e             # 6 suites / 67 tests / 38 snapshots; test/catalog.e2e-spec.ts green

# Self-containment gate (expected: no orchestration references):
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```

Note: infra (rabbitmq/mysql/redis) was left **up and seeded** after the e2e run;
tear it down with `yarn test:infra:down` for a clean slate.
