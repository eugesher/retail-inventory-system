---
epic: epic-03
task_number: 6
title: API-gateway pricing + tax-category endpoints (+ e2e + concurrency test)
depends_on: [1, 2, 3, 4, 5]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md
adr_deliverable: none
---

# Task 06 — API-gateway pricing + tax-category endpoints (+ e2e + concurrency test)

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-009** (`ClientProxy` lives only in the gateway module's
`infrastructure/messaging/*-rabbitmq.adapter.ts`; controllers/use-cases/pipes
inject the port), **ADR-024** (`@RequiresPermission(PermissionCodeEnum.PRICING_WRITE)`
gates the write routes; reads are `@Public()`; customer tokens carry no
`permissions` claim so the code-gated routes are staff-only by construction), and
**ADR-008** (the adapter sends the dotted `ROUTING_KEYS.*`).

## Goal

Front the six pricing/tax RPCs over HTTP by **extending the existing gateway
`catalog` module** (no new module). Add the six routes from the API surface,
their request DTOs, six thin use cases, and the adapter/port methods. Prove the
whole vertical slice end-to-end with `test/pricing.e2e-spec.ts`, including the
publish-no-price **409** and the at-most-one-open concurrency invariant.

## Entry state assumed

- task-01 → task-05 carryover present. The catalog microservice handles six
  pricing/tax RPCs on `catalog_queue` (`catalog.price.set/list/select`,
  `catalog.tax-category.create/list`, `catalog.variant.set-tax-category`); the
  wire contracts (`IPriceSetPayload`, `IPriceQuery`, `ICreateTaxCategoryPayload`,
  `IAttachVariantTaxCategoryPayload`, `PriceView`, `TaxCategoryView`,
  `VariantTaxHeaderView`) live in `libs/contracts/catalog/`. `PriceView` /
  `TaxCategoryView` / `VariantTaxHeaderView` are classes (Swagger-friendly).
- The publish use case hard-fails (409) on a missing active price; the gateway
  publish route already surfaces the wire `statusCode`.
- `PermissionCodeEnum.PRICING_WRITE` exists and is seeded to `admin` +
  `catalog-manager`.
- The gateway `catalog` module shape to mirror: `ICatalogGatewayPort` +
  `CatalogRabbitmqAdapter` (the only `ClientProxy`), thin use cases, and
  `CatalogController` with `@RequiresPermission` / `@Public()` routes + DTOs.

## Scope

**In**
- Extend `ICatalogGatewayPort` + `CatalogRabbitmqAdapter` with the six
  pricing/tax methods (each `firstValueFrom(client.send(ROUTING_KEYS.*, {
  ...command, correlationId }))`).
- Six thin gateway use cases (`apps/api-gateway/.../catalog/application/use-cases/`).
- Six controller routes on the gateway `CatalogController`.
- Request DTOs (`apps/api-gateway/.../catalog/presentation/dto/`).
- `test/pricing.e2e-spec.ts` (the six-step flow) + the concurrency test.
- Doc `06-pricing-api-and-kulala.md` (API/read-path half — task-07 adds the
  Kulala half).

**Out**
- `http/pricing.http` (task-07); the price/tax **seed rows** (task-08). The e2e
  creates its own fixtures via the API so it does not depend on seeded prices.

## API surface (exact)

All routes under the global `api` prefix → `/api/catalog/...`.

| Method | Path | Body / query | Auth | Use case → RPC | Response |
|---|---|---|---|---|---|
| `POST` | `/catalog/variants/:variantId/prices` | `{ currency, amountMinor, validFrom?, validTo?, priority? }` | `@RequiresPermission(PRICING_WRITE)` | SetPrice → `catalog.price.set` | `201` `PriceView` |
| `GET` | `/catalog/variants/:variantId/prices` | `?currency=USD&asOf=…` | `@Public()` | ListPrices → `catalog.price.list` | `200` `PriceView[]` |
| `GET` | `/catalog/variants/:variantId/price` | `?currency=USD&asOf=…` | `@Public()` | GetApplicablePrice → `catalog.price.select` | `200` `PriceView` (or `204`/`null` body when none — pick one and document it) |
| `POST` | `/catalog/tax-categories` | `{ code, name, description? }` | `@RequiresPermission(PRICING_WRITE)` | CreateTaxCategory → `catalog.tax-category.create` | `201` `TaxCategoryView` |
| `GET` | `/catalog/tax-categories` | — | `@Public()` | ListTaxCategories → `catalog.tax-category.list` | `200` `TaxCategoryView[]` |
| `PATCH` | `/catalog/variants/:variantId/tax-category` | `{ taxCategoryCode }` | `@RequiresPermission(PRICING_WRITE)` | AttachVariantTaxCategory → `catalog.variant.set-tax-category` | `200` `VariantTaxHeaderView` |

- `:variantId` parses via `ParseIntPipe` (mirror the existing variant routes).
- The two write `POST`s default to `201`; `PATCH` and the `GET`s use `200`
  (`@HttpCode(HttpStatus.OK)` where Nest would otherwise pick 201/200 wrongly).
- The query `GET`s default `currency` to `USD` and `asOf` to now in the DTO
  (`@Transform`/default), matching the API contract.

## Request DTOs (`apps/api-gateway/.../catalog/presentation/dto/`)

- `SetPriceRequestDto` — `currency: string` (`@Matches(/^[A-Z]{3}$/)`),
  `amountMinor: number` (`@IsInt() @Min(0)`), `validFrom?: string`
  (`@IsOptional() @IsISO8601()`), `validTo?: string` (same), `priority?: number`
  (`@IsOptional() @IsInt()`). Edge guard only — the domain has the final say.
- `PriceQueryDto` — `currency?: string` (default `USD`), `asOf?: string`
  (`@IsISO8601()`); shared by the list + single-price GETs.
- `CreateTaxCategoryRequestDto` — `code: string` (`@Matches(/^[A-Z][A-Z0-9_]*$/)`),
  `name: string` (`@MinLength(1) @MaxLength(255)`), `description?: string`
  (`@MaxLength(1000)`).
- `AttachTaxCategoryRequestDto` — `taxCategoryCode: string`
  (`@Matches(/^[A-Z][A-Z0-9_]*$/)`).

All with `@ApiProperty`/`@ApiPropertyOptional` (mirror `RegisterProductRequestDto`).

## Files to add

- `apps/api-gateway/src/modules/catalog/application/use-cases/set-price.use-case.ts`
- `.../use-cases/list-prices.use-case.ts`
- `.../use-cases/get-applicable-price.use-case.ts`
- `.../use-cases/create-tax-category.use-case.ts`
- `.../use-cases/list-tax-categories.use-case.ts`
- `.../use-cases/attach-variant-tax-category.use-case.ts`
- `apps/api-gateway/.../catalog/presentation/dto/set-price.request.dto.ts`
- `.../dto/price-query.dto.ts`
- `.../dto/create-tax-category.request.dto.ts`
- `.../dto/attach-tax-category.request.dto.ts`
- `test/pricing.e2e-spec.ts`
- `docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md`

## Files to modify

- `apps/api-gateway/.../catalog/application/ports/catalog-gateway.port.ts` — add
  the six method signatures + any command interfaces.
- `apps/api-gateway/.../catalog/infrastructure/messaging/catalog-rabbitmq.adapter.ts`
  — implement the six (each `firstValueFrom(client.send(...))`).
- `apps/api-gateway/.../catalog/presentation/catalog.controller.ts` — add the six
  routes with the documented guards + Swagger decorators.
- `apps/api-gateway/.../catalog/application/use-cases/index.ts`,
  `presentation/dto/index.ts` — barrels.
- `apps/api-gateway/.../catalog/catalog.module.ts` — register the six use cases.

## Files to delete

None.

## Tests

- **E2E** (`test/pricing.e2e-spec.ts`, run by `yarn test:e2e`) — self-contained
  (registers its own draft product + variants via the catalog write routes; does
  not rely on seeded prices):
  1. Seeded admin logs in → bearer. Register a draft product + ≥1 variant.
  2. Publish the product with no price → **409** (assert the status + that it
     stays `draft`).
  3. Set a `USD` price for the variant(s) → `201`/`200` `PriceView`.
  4. Publish the product → `200`, `status: active`.
  5. Customer (no token) `GET /catalog/variants/:variantId/price?currency=USD` →
     the current price.
  6. Schedule a future price (`validFrom = now+1h`, higher `priority`) → the
     current single-price answer is unchanged; `?asOf=<now+2h>` returns the
     future price.
  7. Set a new price now → the previously-open row is closed
     (`validTo == newPrice.validFrom`); a historic `?asOf=<old validFrom>` still
     returns the old price.
  - Permission gating: a customer token (no `permissions`) hitting a write route
    → `403`; an unauthenticated write → `401`.
- **Concurrency test** — fire two `POST /catalog/variants/:variantId/prices`
  (same `(variantId, currency)`) concurrently; assert that afterwards there is
  **at most one** `valid_to IS NULL` row for the scope (query the read endpoints,
  or assert one call wins with a clear error and no open-row collision persists).
  This exercises the `open_scope_key` UNIQUE backstop + the app-level
  close-in-transaction.
- `yarn test:unit` still green (the thin gateway use cases may get light specs;
  follow the existing gateway-module spec depth).

## Doc deliverable

`06-pricing-api-and-kulala.md` (API/read-path half) — the six endpoints, their
auth posture (`PRICING_WRITE` writes vs public reads), the read-path semantics
(`?currency`/`?asOf` defaults; list vs single applicable; the chosen
no-price-found response shape), and how the gateway is a thin port→adapter pass
to `catalog_queue`. Leave a marked section for task-07's Kulala flow.

## Carryover to read

`carryover-01.md` … `carryover-05.md`.

## Carryover to produce

Write `carryover-06.md`. Capture: the six route paths + their guards + the
chosen no-price-found response convention; the gateway use-case + DTO names; the
adapter method signatures; that `test/pricing.e2e-spec.ts` + the concurrency test
exist and pass; that the e2e is self-contained (no seeded prices needed). Note
the gaps (`http/pricing.http` → task-07; seed rows + README/CLAUDE + the
`07-currency-immutability` doc → task-08). Verify commands (including
`yarn test:e2e`).

## Exit criteria

- [ ] All six routes exist with the documented methods, paths, guards, and
      Swagger metadata; `ClientProxy` stays only in the adapter.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes.
- [ ] `yarn test:e2e` passes; `test/pricing.e2e-spec.ts` is green, including the
      publish-no-price 409 and the concurrency invariant.
- [ ] A customer/unauthenticated caller is correctly 403/401'd on the write
      routes; the reads are public.
- [ ] `06-pricing-api-and-kulala.md` (API half) is written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-06.md` is written.
