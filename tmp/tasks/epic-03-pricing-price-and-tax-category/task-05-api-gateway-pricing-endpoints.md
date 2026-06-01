---
epic: epic-03
task_number: 5
title: Add the api-gateway pricing endpoints (Set Price, list/get Price, TaxCategory CRUD, attach TaxCategory to Variant)
depends_on: [task-04]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md
---

# Task 05 — Add the api-gateway pricing endpoints

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Surface the pricing operations from task-03 as HTTP endpoints on `api-gateway`. Extend the existing `apps/api-gateway/src/modules/catalog/` module from epic-02 task-06 with new use cases, controllers, DTOs, and pipes. After this task, an authenticated admin can `POST` a new Price for a variant, `GET` the current Price or the list of Prices in effect, manage `TaxCategory` codes, and attach a TaxCategory to a variant — all via the public HTTP surface. The api-gateway layer is itself a thin pass-through: each new controller method validates the input, calls the matching RPC pattern on `catalog_queue`, and serialises the response.

The endpoints land **inside** the existing gateway catalog module (not a new gateway module) to mirror the microservice-side colocation: `pricing/` is a sibling module inside `catalog-microservice`, and from the api-gateway's perspective everything pricing also lives under `/api/catalog/...`. This keeps the gateway URL design honest about where the data lives.

## Entry state assumed

Task-04 complete. Specifically:

- `apps/api-gateway/src/modules/catalog/` exists from epic-02 task-06 with the canonical per-module hexagonal layout (`domain`-free at the gateway — gateways have no domain models, just DTOs + use cases + a controller; verify the existing shape and clone it).
- The gateway already speaks to `catalog_queue` via the RMQ adapter registered in epic-02 task-06. The adapter implements a catalog port (e.g. `CatalogMicroservicePort`) which has methods like `listProducts`, `getProduct`, etc. This task extends the port + adapter.
- The catalog controller already has `POST /api/catalog/products`, `GET /api/catalog/products`, `POST /api/catalog/products/:productId/publish`, etc.
- `PermissionsGuard` + `@RequiresPermission()` + `@Public()` decorators from epic-01 task-04 are in place.
- The seven new `catalog.*` RPC patterns from task-03 are registered in `libs/contracts/microservices/microservice-message-pattern.enum.ts`.
- A `PublishPreconditionFailedError → 409 Conflict` mapping was reviewed in task-04; whichever resolution that task chose, the gateway's domain-error filter now handles the new error correctly.

## Scope

**In:**

- Extend the catalog port (or introduce a sibling `CatalogPricingPort` if epic-02 split read and write into separate ports — clone the existing convention) with methods that mirror the seven new RPC patterns:
  - `setPrice(input): Promise<PriceDto>`
  - `schedulePrice(input): Promise<PriceDto>`
  - `selectApplicablePrice(input): Promise<PriceDto | null>`
  - `listPricesInEffect(input): Promise<PriceDto[]>`
  - `listTaxCategories(): Promise<TaxCategoryDto[]>`
  - `createTaxCategory(input): Promise<TaxCategoryDto>`
  - `attachTaxCategoryToVariant(input): Promise<ProductVariantDto>`
- Extend the RMQ adapter implementation to add the seven methods, each issuing `client.send(pattern, payload)` against the existing `catalog_queue` client. Add the method-to-pattern mapping in one place (do not let the controller call `client.send` directly).
- Add seven new use cases under `apps/api-gateway/src/modules/catalog/application/use-cases/`, each a one-method class that calls into the port. The use case layer at the gateway exists solely as a unit-test seam — controllers test thinly with mocked ports; use cases test thinly with mocked ports too; the layering convention from epic-02 is preserved.
- Add the controller methods. Follow the table below for routes, guards, request DTO, and response DTO names.
- Add the six new request DTOs and three new response DTOs (see §"DTOs and pipes" below). All request DTOs use `class-validator` decorators for input validation.
- Add the pipes / parsers that convert raw `Date` strings and currency strings to the right shapes before the use case sees them. Specifically: a `ParseIsoDateOrUndefinedPipe`, a `NormalizeCurrencyPipe` (uppercases + 3-char shape check). If equivalent pipes already exist in `apps/api-gateway/src/common/pipes/`, reuse them.
- Modify `apps/api-gateway/src/modules/catalog/catalog.module.ts` to register the new providers (port + adapter, seven use cases, controller is unchanged file but gains methods).
- Doc deliverable `06-pricing-api-and-kulala.md` (api half — task-06 appends the Kulala half).

**Out:**

- The Kulala HTTP file — task-06.
- The `pricing:write` permission seed into the `admin` + `catalog-manager` roles — task-07.
- E2E tests — task-07 authors `test/pricing.e2e-spec.ts`.
- Any rate / discount / promotion logic — `epic-15`.

## Endpoint table

The full surface from the epic, with notes on the controller method names, guard, request/response, and the underlying RPC pattern. Mirror the existing catalog controllers for the route prefix (`/api/catalog`).

| Method | Path                                                          | Guard / Permission                         | Request DTO                | Response DTO          | Backing RPC                                  |
| ------ | ------------------------------------------------------------- | ------------------------------------------ | -------------------------- | --------------------- | -------------------------------------------- |
| POST   | `/api/catalog/variants/:variantId/prices`                     | bearer + `@RequiresPermission('pricing:write')` | `SetPriceRequestDto`       | `PriceResponseDto`    | `catalog.price.set` (or `.schedule`, see §"Set vs. Schedule routing") |
| GET    | `/api/catalog/variants/:variantId/prices`                     | `@Public()`                                | query params               | `PriceResponseDto[]`  | `catalog.price.list`                         |
| GET    | `/api/catalog/variants/:variantId/price`                      | `@Public()`                                | query params               | `PriceResponseDto` or 404 | `catalog.price.select`                  |
| POST   | `/api/catalog/tax-categories`                                 | bearer + `@RequiresPermission('pricing:write')` | `CreateTaxCategoryRequestDto` | `TaxCategoryResponseDto` | `catalog.tax-category.create`         |
| GET    | `/api/catalog/tax-categories`                                 | `@Public()`                                | —                          | `TaxCategoryResponseDto[]` | `catalog.tax-category.list`             |
| PATCH  | `/api/catalog/variants/:variantId/tax-category`               | bearer + `@RequiresPermission('pricing:write')` | `AttachTaxCategoryRequestDto` | `ProductVariantResponseDto` | `catalog.variant.attach-tax-category` |

## Set vs. Schedule routing

The epic specifies a single endpoint for both Set Price and Schedule Price: `POST /variants/:variantId/prices`. The two paths differ only by `validFrom` — Set has `validFrom <= now` (or omitted; the use case defaults to now), Schedule has `validFrom > now`.

**Decision**: the controller dispatches based on the payload:

- If `body.validFrom` is missing or `<= now (after the date pipe parses it)`: call the `setPrice` port method → `catalog.price.set` RPC.
- If `body.validFrom > now`: call the `schedulePrice` port method → `catalog.price.schedule` RPC.

This keeps the HTTP surface flat (one endpoint, the operator does not need to choose) and preserves the audit-trail distinction (two routing keys downstream). Document the dispatch in the doc deliverable and in the controller method as a single-line comment explaining the branch (the WHY is the audit-key split; the WHAT is obvious from the code, so the comment is short).

Alternative considered + rejected: a separate `POST /variants/:variantId/prices/scheduled` endpoint. Rejected because (a) the input shapes are identical, (b) the operator-facing intent is "I want this price to take effect at time T," and (c) the audit consumer does not care about the URL — it keys on the routing key, which the use case picks independently.

## DTOs and pipes

Request DTOs (under `apps/api-gateway/src/modules/catalog/application/dto/` — clone the existing catalog DTO layout):

- `SetPriceRequestDto`:
  - `@IsString() @Length(3, 3) @Matches(/^[A-Z]{3}$/i) currency: string;`
  - `@IsInt() @Min(0) amountMinor: number;`
  - `@IsOptional() @IsISO8601() validFrom?: string;`
  - `@IsOptional() @IsISO8601() validTo?: string;` — required to be `> validFrom` if set; cross-field validator added inline.
  - `@IsOptional() @IsInt() @Min(0) priority?: number;`
- `CreateTaxCategoryRequestDto`:
  - `@Matches(/^[A-Z][A-Z0-9_]*$/, { message: 'code must be UPPER_SNAKE_CASE' }) @Length(1, 50) code: string;`
  - `@Length(1, 100) name: string;`
  - `@IsOptional() @Length(0, 500) description?: string;`
- `AttachTaxCategoryRequestDto`:
  - `@Matches(/^[A-Z][A-Z0-9_]*$/) @Length(1, 50) taxCategoryCode: string;`

Query params for the read endpoints are validated via a small DTO too (`ListPricesQueryDto`, `GetPriceQueryDto`) with `@IsOptional() @IsString() @Length(3,3) currency?: string;` and `@IsOptional() @IsISO8601() asOf?: string;`. Both default at the use-case layer (currency → `DEFAULT_CURRENCY`; asOf → now). The currency default lives in the **gateway**'s config, not the microservice's, since the endpoint surface is what the operator sees; the microservice's Select use case accepts a required currency and the gateway is responsible for the default.

Response DTOs (under `apps/api-gateway/src/modules/catalog/application/dto/`):

- `PriceResponseDto`: `{ id, variantId, currency, amountMinor, validFrom, validTo, priority, createdAt, updatedAt }`. Dates serialised as ISO-8601 strings.
- `TaxCategoryResponseDto`: `{ id, code, name, description }`.
- `ProductVariantResponseDto`: the existing variant DTO from epic-02, extended with the new `taxCategoryId: number | null` field. If the existing DTO already projects all fields generically, no edit is needed here.

Pipes:

- `ParseIsoDateOrUndefinedPipe` — parses an optional ISO-8601 query parameter into a `Date` or returns `undefined`. Reuse if exists.
- `NormalizeCurrencyPipe` — uppercases + asserts 3 chars. Reuse if exists.
- Cross-field validator on `SetPriceRequestDto` ensuring `validFrom < validTo` when both are set. If `class-validator`'s `@ValidateBy` is in use elsewhere, follow that convention; otherwise a small custom validator.

## Controller method signatures (representative)

```ts
@Controller('api/catalog')
export class CatalogController {
  // … existing methods from epic-02 …

  @Post('variants/:variantId/prices')
  @RequiresPermission(PermissionsEnum.PRICING_WRITE)
  async setOrSchedulePrice(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() body: SetPriceRequestDto,
  ): Promise<PriceResponseDto> {
    const validFrom = body.validFrom ? new Date(body.validFrom) : undefined;
    const isFutureDated = validFrom !== undefined && validFrom > new Date();
    return isFutureDated
      ? this.schedulePriceUseCase.execute({ variantId, ...body })
      : this.setPriceUseCase.execute({ variantId, ...body });
  }

  @Get('variants/:variantId/prices')
  @Public()
  async listPricesInEffect(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Query() query: ListPricesQueryDto,
  ): Promise<PriceResponseDto[]> {
    return this.listPricesUseCase.execute({
      variantId,
      currency: (query.currency ?? this.config.defaultCurrency).toUpperCase(),
      asOf: query.asOf ? new Date(query.asOf) : undefined,
    });
  }

  // … similar for the other four endpoints …
}
```

The existing catalog controller may already exceed the file-size budget the project enforces (epic-02 split write/read into two controllers if a budget existed; check). If `catalog.controller.ts` is getting long, split into `catalog-pricing.controller.ts` for the new methods. Decision criterion: if `catalog.controller.ts` is already > 200 lines after epic-02, split. If not, append.

## `PermissionsEnum` extension

Add `PRICING_WRITE = 'pricing:write'` to the permissions enum (location: typically `libs/contracts/auth/permissions.enum.ts` or similar — `grep` for `CATALOG_WRITE` to find the file). If the permission code is also enforced by a SQL-seeded permissions table (epic-01 task-01), task-07 (this epic) extends the seed; here we only add the enum value.

## Module wiring

`apps/api-gateway/src/modules/catalog/catalog.module.ts`:

- Register the seven new use cases as providers.
- If the port + adapter were split previously (write vs. read), keep that split. Otherwise, the existing single port grows.
- No new external module imports needed — the `MicroserviceClientCatalogModule` from epic-02 task-01 / epic-02 task-06 already provides the RMQ client.

## Error mapping

The microservice throws domain errors. The gateway translates:

- `PublishPreconditionFailedError` (task-04) → `409 Conflict`.
- `ConcurrencyError` (task-03 — concurrent open-Price race) → `409 Conflict` with a different body.
- `DomainError('Use SchedulePriceUseCase for future-dated prices')` (task-03 — wrong-path error) → never surfaces, because the controller dispatches correctly above. If it ever does, map to `400 Bad Request`.
- `NotFoundError` (variant unknown, tax-category code unknown) → `404 Not Found`.

The existing gateway exception filter is the place that handles this. Verify it does — if any of the four error types listed above is not covered, add an entry. The doc deliverable lists what was checked + what was added.

## Tests

This task does not author the e2e pricing test (that is task-07). Unit-level coverage:

- For each of the seven new use cases at the gateway: a one-fixture spec that mocks the port and asserts the use case calls the right port method with the right arguments. These specs are thin — they exist to verify the wiring, not the behaviour. Behaviour is covered by the microservice-side specs in task-03 + the e2e in task-07.
- For the controller method `setOrSchedulePrice`: two fixtures — `validFrom > now` routes to schedule; `validFrom <= now` (or omitted) routes to set.
- DTO validation specs are optional — `class-validator` is exercised end-to-end at e2e time. Add one or two illustrative specs only if the existing catalog gateway tests do.

## Files to add

- `apps/api-gateway/src/modules/catalog/application/use-cases/set-price.use-case.ts` (+ spec).
- `apps/api-gateway/src/modules/catalog/application/use-cases/schedule-price.use-case.ts` (+ spec).
- `apps/api-gateway/src/modules/catalog/application/use-cases/select-applicable-price.use-case.ts` (+ spec).
- `apps/api-gateway/src/modules/catalog/application/use-cases/list-prices-in-effect.use-case.ts` (+ spec).
- `apps/api-gateway/src/modules/catalog/application/use-cases/list-tax-categories.use-case.ts` (+ spec).
- `apps/api-gateway/src/modules/catalog/application/use-cases/create-tax-category.use-case.ts` (+ spec).
- `apps/api-gateway/src/modules/catalog/application/use-cases/attach-tax-category-to-variant.use-case.ts` (+ spec).
- `apps/api-gateway/src/modules/catalog/application/dto/set-price-request.dto.ts`.
- `apps/api-gateway/src/modules/catalog/application/dto/create-tax-category-request.dto.ts`.
- `apps/api-gateway/src/modules/catalog/application/dto/attach-tax-category-request.dto.ts`.
- `apps/api-gateway/src/modules/catalog/application/dto/list-prices-query.dto.ts`.
- `apps/api-gateway/src/modules/catalog/application/dto/get-price-query.dto.ts`.
- `apps/api-gateway/src/modules/catalog/application/dto/price-response.dto.ts`.
- `apps/api-gateway/src/modules/catalog/application/dto/tax-category-response.dto.ts`.
- `apps/api-gateway/src/modules/catalog/presentation/catalog-pricing.controller.ts` (only if a split is chosen).
- `docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md` (api half — task-06 appends).

## Files to modify

- `apps/api-gateway/src/modules/catalog/application/ports/catalog.port.ts` (or split write/read port) — add the seven new methods.
- `apps/api-gateway/src/modules/catalog/infrastructure/catalog.rmq.adapter.ts` — implement the seven new methods.
- `apps/api-gateway/src/modules/catalog/presentation/catalog.controller.ts` — append the six method handlers, or extract to `catalog-pricing.controller.ts` per the split decision.
- `apps/api-gateway/src/modules/catalog/catalog.module.ts` — register the seven new use case providers (and the new controller if split).
- `apps/api-gateway/src/modules/catalog/application/dto/product-variant-response.dto.ts` — add `taxCategoryId: number | null` if not already projected.
- `libs/contracts/auth/permissions.enum.ts` (or wherever the catalog `*_WRITE` permission lives) — add `PRICING_WRITE = 'pricing:write'`.
- `apps/api-gateway/src/common/filters/domain-error.filter.ts` (if exists; otherwise the equivalent file) — extend the error → status-code mapping if necessary.

## Files to delete

None.

## Doc deliverable

Write `docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md` — **api half only** in this task; task-06 appends the Kulala half. Target the api half at ~150 lines. Sections:

1. **Why pricing endpoints live under `/api/catalog`.** Mirrors the microservice-side module colocation. URL design honesty: a future reader of the URL can predict the bounded context.
2. **Endpoint table, full reference.** Reproduce the §"Endpoint table" content; expand each row with a one-paragraph note on intent.
3. **The single Set/Schedule endpoint.** The dispatch logic. The two RPC paths it fans out to. The audit-key distinction preserved downstream.
4. **DTO and validation choices.** The currency-uppercase pipe. The ISO-8601 pipe. The cross-field validator on `validFrom < validTo`. Why `code` validation is regex-only (no allow-list of known codes — operators can invent new codes).
5. **Permission model.** `pricing:write` lands on every write endpoint. Read endpoints are public (`@Public()`) — anyone can query the price of a public product. The `pricing:write` code is seeded into the `admin` + `catalog-manager` roles in task-07.
6. **Error shapes.** Sample 404 body, sample 409 body for `PublishPreconditionFailedError`, sample 409 body for `ConcurrencyError`. The body envelope follows the gateway-wide convention from epic-01 / epic-02.
7. **Forward-looking: caching.** The read endpoints (`GET …/price`, `GET …/prices`) are intentionally uncached at this stage. The cache-key builder from task-01 exists but is unused. The threshold for switching the read path to cache-aside is documented in the README (task-07 owns the README edit). Forward-link: when cache lands, the cache key follows the builder shape `ris:catalog:price:v1:<variantId>:<currency>`.
8. **What this doc does NOT cover.** Cross-link to task-06's appended Kulala section, to task-04's 409 mapping doc, and to task-03's RPC pattern doc.

## Carryover produced (consumed by task-06 onward)

- Six new HTTP endpoints are live. Task-06's Kulala file calls them.
- The seven new use cases at the gateway have spec coverage. The microservice-side specs (task-03) + the gateway-side specs (task-05) + the e2e specs (task-07) form the test pyramid.
- The `pricing:write` permission code is in the enum; task-07 seeds it into roles.
- The doc 06 has its api half written; task-06 appends the Kulala half.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the seven new gateway use-case specs and the controller dispatch spec are green.
- [ ] `yarn build:api-gateway` succeeds.
- [ ] `docker compose up -d && yarn start:dev:api-gateway` boots cleanly; the new routes appear in the Nest startup log (`Mapped {/api/catalog/variants/:variantId/prices, POST}` etc.).
- [ ] Manual smoke: `curl -X POST http://localhost:3000/api/catalog/variants/1/prices -H 'Authorization: Bearer …' -H 'Content-Type: application/json' -d '{"currency":"USD","amountMinor":1999}'` returns 200 with a `PriceResponseDto`-shaped body. (Assumes task-07's seed is run, or that you set a Price by hand first.)
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `06-pricing-api-and-kulala.md` exists with the api half filled per the section list; task-06's Kulala half is left as a clearly marked TODO at the bottom of the file (or simply absent — task-06 owns the append).
