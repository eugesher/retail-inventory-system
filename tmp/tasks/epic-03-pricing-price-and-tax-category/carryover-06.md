# Carryover 06 — API-gateway pricing + tax-category endpoints (+ e2e + concurrency)

State handed forward from task-06 to task-07 (and beyond). Read this before
touching the gateway catalog module. (Read `carryover-01.md` … `carryover-05.md`
first.)

## Entry state for task-07

The six pricing/tax RPCs are now fronted over HTTP by the **existing gateway
`catalog` module** (`apps/api-gateway/src/modules/catalog/` — no new module). The
gateway holds no pricing logic; each route is a thin port→adapter pass to
`catalog_queue`. lint / format / unit / e2e all green; all five apps build.

### The six routes (all under the global `api` prefix → `/api/catalog/...`)

| Method | Path | Body / query | Guard | Use case → RPC | Success |
|---|---|---|---|---|---|
| `POST` | `/catalog/variants/:variantId/prices` | `{ currency, amountMinor, validFrom?, validTo?, priority? }` | `@RequiresPermission(PRICING_WRITE)` | `SetPriceUseCase` → `catalog.price.set` | `201` `PriceView` |
| `GET` | `/catalog/variants/:variantId/prices` | `?currency=USD&asOf=…` | `@Public()` | `ListPricesUseCase` → `catalog.price.list` | `200` `PriceView[]` |
| `GET` | `/catalog/variants/:variantId/price` | `?currency=USD&asOf=…` | `@Public()` | `GetApplicablePriceUseCase` → `catalog.price.select` | `200` `PriceView` **or `null` body** |
| `POST` | `/catalog/tax-categories` | `{ code, name, description? }` | `@RequiresPermission(PRICING_WRITE)` | `CreateTaxCategoryUseCase` → `catalog.tax-category.create` | `201` `TaxCategoryView` |
| `GET` | `/catalog/tax-categories` | — | `@Public()` | `ListTaxCategoriesUseCase` → `catalog.tax-category.list` | `200` `TaxCategoryView[]` |
| `PATCH` | `/catalog/variants/:variantId/tax-category` | `{ taxCategoryCode }` | `@RequiresPermission(PRICING_WRITE)` | `AttachVariantTaxCategoryUseCase` → `catalog.variant.set-tax-category` | `200` `VariantTaxHeaderView` |

- `:variantId` parses via `ParseIntPipe`. The `PATCH` carries
  `@HttpCode(HttpStatus.OK)`; the two `POST`s default `201`; the reads `200`.
- **No-price-found convention (chosen + documented): `200` with a `null` JSON
  body.** The gateway surfaces the `catalog.price.select` `PriceView | null`
  unchanged — it does **not** promote "no price in effect" to a `404` (an unknown
  *variant/slug* is still a real `404`; "no price at this instant" is a normal
  queryable answer). No `@Res` is used (the gateway has none) — the use case/port
  return `PriceView | null` and Nest serializes the `null`.

### Files added (gateway)

- `application/use-cases/set-price.use-case.ts`
- `application/use-cases/list-prices.use-case.ts`
- `application/use-cases/get-applicable-price.use-case.ts`
- `application/use-cases/create-tax-category.use-case.ts`
- `application/use-cases/list-tax-categories.use-case.ts`
- `application/use-cases/attach-variant-tax-category.use-case.ts`
- `presentation/dto/set-price.request.dto.ts`
- `presentation/dto/price-query.dto.ts`
- `presentation/dto/create-tax-category.request.dto.ts`
- `presentation/dto/attach-tax-category.request.dto.ts`
- `test/pricing.e2e-spec.ts`
- `test/data-source/pricing.e2e-spec.data-source.ts` (a `countOpenPrices(variantId,
  currency)` helper for the concurrency invariant — added beyond the task's file
  list; mirrors `catalog.e2e-spec.data-source.ts`, imported by path, not via the
  `data-source/index.ts` barrel)
- `docs/implementation/03-pricing-price-and-tax-category/06-pricing-api-and-kulala.md`

### Files modified (gateway + shared)

- `application/ports/catalog-gateway.port.ts` — added six method signatures +
  four command/query shapes (below). Exports `PriceView` / `TaxCategoryView` /
  `VariantTaxHeaderView` imports.
- `infrastructure/messaging/catalog-rabbitmq.adapter.ts` — implemented the six
  (each `firstValueFrom(client.send(ROUTING_KEYS.*, { ...command, correlationId }))`).
- `presentation/catalog.controller.ts` — six routes + Swagger decorators; injects
  the six new use cases.
- `application/use-cases/index.ts`, `presentation/dto/index.ts` — barrels.
- `catalog.module.ts` — registers the six new use cases.
- `libs/database/database.module.ts` — **`timezone: 'Z'`** (see the deviation
  below).
- `README.md`, `CLAUDE.md` — routes/diagram/tree + the UTC-driver operational note.

### Port additions (`ICatalogGatewayPort`)

```ts
setPrice(command: ISetPriceCommand, correlationId: string): Promise<PriceView>;
listPrices(query: IPriceQueryCommand, correlationId: string): Promise<PriceView[]>;
getApplicablePrice(query: IPriceQueryCommand, correlationId: string): Promise<PriceView | null>;
createTaxCategory(command: ICreateTaxCategoryCommand, correlationId: string): Promise<TaxCategoryView>;
listTaxCategories(correlationId: string): Promise<TaxCategoryView[]>;
attachVariantTaxCategory(command: IAttachVariantTaxCategoryCommand, correlationId: string): Promise<VariantTaxHeaderView>;
```

New command/query shapes (omit `correlationId` — the adapter stitches it on):
`ISetPriceCommand { variantId, currency, amountMinor, validFrom?, validTo?,
priority? }`, `IPriceQueryCommand { variantId, currency, asOf? }`,
`ICreateTaxCategoryCommand { code, name, description? }`,
`IAttachVariantTaxCategoryCommand { variantId, taxCategoryCode }`. `variantId` is
folded in from the route `:variantId` in the controller (same split add-variant
uses for `:productId`).

### Request DTOs (edge guards; domain has the final say)

- `SetPriceRequestDto` — `currency` (`@Matches(/^[A-Z]{3}$/)`), `amountMinor`
  (`@IsInt() @Min(0)`), `validFrom?`/`validTo?` (`@IsISO8601()`), `priority?`
  (`@IsInt()`).
- `PriceQueryDto` — `currency` (field-default `'USD'`), `asOf` (field-default
  `new Date().toISOString()`); shared by the two price GETs. The field-initializer
  defaults survive the global `ValidationPipe({ transform: true })`.
- `CreateTaxCategoryRequestDto` — `code` (`@Matches(/^[A-Z][A-Z0-9_]*$/)`), `name`
  (`@MinLength(1) @MaxLength(255)`), `description?` (`@MaxLength(1000)`).
- `AttachTaxCategoryRequestDto` — `taxCategoryCode` (`@Matches(/^[A-Z][A-Z0-9_]*$/)`).

## Key decision / deviation the next session MUST respect

**A timezone bug was fixed at the persistence layer (`libs/database`).** The live
publish-after-pricing flow (set a price via the new gateway route, then publish)
**409'd** because the `mysql2` driver defaulted to the **Node host's local
timezone**: a domain-written `price.valid_from` (`new Date()`) was stored as local
wall-clock, while the catalog publish-precondition probe compares it against the
server-side `UTC_TIMESTAMP()` (UTC). On a UTC+7 host that is a 7-hour mismatch, so
the just-priced variant read back as "no active price". (The catalog e2e never saw
this — it seeds prices via raw SQL `valid_from = UTC_TIMESTAMP()`, already UTC.)

Fix: `DatabaseModule.forRoot` now sets **`timezone: 'Z'`**, so JS `Date`s are
written/read as UTC wall-clock, matching the server clock and `UTC_TIMESTAMP()`
(and also correcting how DB-generated `CURRENT_TIMESTAMP` values are read on a
non-UTC host). This is a one-line connection-config correctness fix (ADR-019, no
ADR needed — a bug fix, not a new decision). It is **system-wide** (all four apps
share the one `forRoot`); the full e2e suite was re-run green afterwards (no
regression in catalog/order/stock/system-api/notification snapshots). **Do not
revert it** — the pricing publish flow depends on it. The catalog probe
(`ActivePriceProbeTypeormAdapter`) was left unchanged (its `UTC_TIMESTAMP()` is now
correct); its spec is unaffected.

Secondary: the `price.valid_from` column is second-granular (`TIMESTAMP(0)`), so
MySQL **rounds** a sub-second `validFrom` to the nearest whole second — a just-set
immediate price can round *up* and momentarily sit one second ahead of
`UTC_TIMESTAMP()`. The e2e waits ~1.5s between the last Set and the publish
(`settleTimestampRounding()`) so the precondition is deterministically met — the
realistic "price first, publish later" gap. The future-price test asserts
`validFrom` **within a 1s drift**, not exact-string equality, for the same reason.

## Tests

- `test/pricing.e2e-spec.ts` — **19 tests, green**, self-contained (registers its
  own draft product + variants via the catalog write routes; **no seeded price
  needed**). Covers: publish-no-price **409** (product stays `draft`) → set USD
  prices → publish `200` `active` → anonymous read current price → schedule a
  future higher-priority price (current answer unchanged; `?asOf=now+2h` →
  future) → append-and-close (predecessor `validTo == newPrice.validFrom`; historic
  `?asOf` → old) → tax create/duplicate-409/list/attach → **concurrency** (two
  racing `POST .../prices` for one scope leave exactly one open `valid_to IS NULL`
  row — `open_scope_key` UNIQUE + close-in-transaction; ≥1 wins, any loser is a
  clear error) → auth gates (staff-without-`pricing:write` `403`, customer token
  `403`, no-token `401`, public reads `200`).
- `yarn test:unit` — **475 tests / 68 suites**, unchanged (no new gateway unit
  specs: the gateway catalog module has **none** today, so the thin pricing use
  cases follow that depth — they are exercised by the e2e).
- `yarn test:e2e` — **95 tests / 7 suites** (was 76 / 6: +19 pricing, +1 suite).

## Known gaps / deferrals (each owned by a later task)

- **`http/pricing.http`** (the Kulala request collection for the six routes) →
  **task-07**. `06-pricing-api-and-kulala.md` has a reserved "## 7. Kulala HTTP
  exercises" section for it (written self-contained — no orchestration words).
- **Price/tax seed rows** (+ variant attachments), the README `DEFAULT_CURRENCY`
  env-var table row, and the `07-currency-immutability` doc → **task-08**. The
  `tax_category` table is still empty except whatever the e2e creates (stamped, so
  idempotent across runs). The e2e does **not** depend on any seed.

## How to verify (all run green at end of task-06)

- `yarn lint` — exit 0 (`--max-warnings 0`). `ClientProxy` stays only in
  `catalog-rabbitmq.adapter.ts`.
- `yarn format:check` — clean.
- `yarn build` — all five apps compile.
- `yarn test:unit` — 475 / 68 pass.
- `yarn test:e2e` — 95 / 7 pass on a fresh infra reload + migrate + seed.
  - Targeted: `yarn test:e2e:run --testPathPattern pricing` (needs infra up;
    `yarn test:infra:reload` first if the DB is stale).
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`
  → no orchestration references.
