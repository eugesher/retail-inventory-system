# 06 — Pricing API at the gateway

This document records the **HTTP surface** that fronts the pricing capability: six
routes on the API gateway that put the catalog microservice's pricing and
tax-category RPCs behind `/api/catalog/...`. It builds on the RPC application
layer in
[05 — Set / Schedule / Select Applicable Price](05-select-applicable-price.md) and
[03 — Tax categories and variant attachment](03-tax-category-and-variant-attachment.md),
and on the publish precondition in
[04 — The publish precondition hard-fail](04-publish-precondition-hard-fail.md).

It is governed by [ADR-009](../../adr/009-port-adapter-at-the-gateway.md)
(`ClientProxy` lives only in the gateway module's
`infrastructure/messaging/*-rabbitmq.adapter.ts`; controllers, use cases, and
pipes inject the port), [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
(`@RequiresPermission(PRICING_WRITE)` gates the writes; reads are `@Public()`),
and [ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md) (the adapter sends the
dotted `ROUTING_KEYS.*`).

There is **no new gateway module** — the six routes extend the existing gateway
`catalog` module (`apps/api-gateway/src/modules/catalog/`), because a price and a
tax category both address a *variant*, which the catalog module already fronts.

## 1. The six routes

All routes sit under the global `api` prefix, so `/catalog/...` resolves to
`/api/catalog/...`.

| Method  | Path                                        | Body / query                                                 | Auth            | Use case → RPC                                                         | Success                      |
|---------|---------------------------------------------|--------------------------------------------------------------|-----------------|------------------------------------------------------------------------|------------------------------|
| `POST`  | `/catalog/variants/:variantId/prices`       | `{ currency, amountMinor, validFrom?, validTo?, priority? }` | `PRICING_WRITE` | `SetPriceUseCase` → `catalog.price.set`                                | `201` `PriceView`            |
| `GET`   | `/catalog/variants/:variantId/prices`       | `?currency=USD&asOf=…`                                       | public          | `ListPricesUseCase` → `catalog.price.list`                             | `200` `PriceView[]`          |
| `GET`   | `/catalog/variants/:variantId/price`        | `?currency=USD&asOf=…`                                       | public          | `GetApplicablePriceUseCase` → `catalog.price.select`                   | `200` `PriceView` or `null`  |
| `POST`  | `/catalog/tax-categories`                   | `{ code, name, description? }`                               | `PRICING_WRITE` | `CreateTaxCategoryUseCase` → `catalog.tax-category.create`             | `201` `TaxCategoryView`      |
| `GET`   | `/catalog/tax-categories`                   | —                                                            | public          | `ListTaxCategoriesUseCase` → `catalog.tax-category.list`               | `200` `TaxCategoryView[]`    |
| `PATCH` | `/catalog/variants/:variantId/tax-category` | `{ taxCategoryCode }`                                        | `PRICING_WRITE` | `AttachVariantTaxCategoryUseCase` → `catalog.variant.set-tax-category` | `200` `VariantTaxHeaderView` |

`:variantId` parses with `ParseIntPipe` (mirroring the existing variant routes).
The two `POST`s default to `201`; the `PATCH` carries `@HttpCode(HttpStatus.OK)`
so it returns `200` (Nest would otherwise pick `200` for `PATCH` anyway, but the
decorator is explicit so the contract is greppable). The reads are `200`.

## 2. Auth posture: writes gated, reads public

The three mutations — set/schedule a price, create a tax category, attach a tax
category to a variant — are gated by
`@RequiresPermission(PermissionCodeEnum.PRICING_WRITE)` (`pricing:write`, seeded to
`admin` and `catalog-manager`). The three reads (list prices, single applicable
price, list tax categories) are `@Public()` so an unauthenticated shopper can read
prices while browsing.

Because a **customer** access token carries no `permissions` claim (ADR-024), any
code-gated route is **staff-only by construction**: a customer hitting a write
route is `403`, an unauthenticated write is `401`. The e2e proves all three
postures (staff-without-`pricing:write` → `403`, customer token → `403`,
no token → `401`, public reads → `200`).

## 3. Read-path semantics

Both price GETs answer the same `(variantId, currency)`-scoped question at a point
in time, and share one query DTO (`PriceQueryDto`):

- **`?currency`** is optional, and an omitted one resolves to the deployment's
  configured default so the caller reads the default-currency price. The shape is
  validated (`^[A-Z]{3}$`); the scope is always carried on the wire.
- **`?asOf`** defaults to **now** at the edge (an ISO-8601 field default), so a
  caller that omits it reads the *currently* applicable price. A supplied `?asOf`
  resolves the ledger as of that instant — this is how a caller reads a historic
  or a scheduled-future price.

#### Where the `currency` default lives — and why it moved (ISSUE-11)

As shipped here, `PriceQueryDto` carried `public currency = 'USD'` — a field
initializer the global `ValidationPipe` (`transform: true`) keeps, so an omitted
`?currency=` put the literal `USD` on the wire on the caller's behalf. That was a
bug on any shop configured otherwise: with `DEFAULT_CURRENCY=EUR` the catalog holds
only EUR prices (a variant cannot even publish without an active price in
`CATALOG_DEFAULT_CURRENCY`), so both `@Public()` reads asked for a currency the
catalog does not stock and found **nothing, for every variant** — a correctly
configured shop that could not display a price.

The fix moved the default one layer in, not out. `PriceQueryDto.currency` is now
`@IsOptional()` with no initializer, and `ListPricesUseCase` /
`GetApplicablePriceUseCase` resolve `query.currency ?? this.defaultCurrency` before
dispatching, injecting `CATALOG_GATEWAY_DEFAULT_CURRENCY` — a `ConfigService`-backed
value provider over the same `DEFAULT_CURRENCY` the catalog prices against. The
decision that defaulting is a **gateway** concern (`IPriceQuery.currency` stays
required on the wire) was right and is kept; only the *source* of the default was
wrong, and a DTO cannot inject `ConfigService`. `?asOf`'s initializer stays — "now"
is not configurable.

The two reads differ in **what** they return for that scope/instant:

- **`GET .../prices`** (list) returns **every** `PriceView` row in effect at
  `asOf` — no collapse. Useful for showing overlapping rows (e.g. a base price and
  a higher-priority promo).
- **`GET .../price`** (single) returns the **one** applicable `PriceView` resolved
  by the catalog use case's policy (highest `priority`, then latest `validFrom`),
  or **`null`** when none is in effect.

### No price in effect → `200` with a `null` body

The single-applicable read resolves to `PriceView | null` at the RPC. The gateway
is a thin pass-through and **does not promote "no price" to a `404`** — it surfaces
the `null` unchanged as a **`200` with a `null` JSON body**. The rationale: "no
price is in effect at this instant" is a normal, queryable answer, not a missing
resource. (Contrast the catalog reads, where an *unknown variant/slug* is a genuine
`404`.) Callers branch on a null body, not on a status code.

## 4. The gateway is a thin port→adapter pass

Each route does the minimum: the controller validates the request DTO at the edge,
folds the route `:variantId` into the command (the same split the existing
add-variant route uses for `:productId`), and calls a thin use case. The use case
assigns the `correlationId`, logs, calls the port, and translates any wire error to
the matching HTTP status via the shared `throwRpcError` helper (`404`/`400`/`409`
pass through; anything else is a `500`).

The single holder of a `ClientProxy` is `CatalogRabbitmqAdapter` — extended here
with the six methods, each a
`firstValueFrom(client.send(ROUTING_KEYS.*, { ...command, correlationId }))`. The
port (`ICatalogGatewayPort`) gained the six signatures and four command/query
shapes (`ISetPriceCommand`, `IPriceQueryCommand`, `ICreateTaxCategoryCommand`,
`IAttachVariantTaxCategoryCommand`); the controller and use cases depend only on
the port (ADR-009). No domain state lives at the gateway — pricing logic stays in
`catalog_queue`.

A **fifth** shape, `IPriceQueryRequest`, joined with the ISSUE-11 fix in §3. It is
`IPriceQueryCommand` with `currency` optional, and the two differ by exactly that
one `?`: the *Request* is what arrives from the edge, the *Command* is what goes on
the wire with a **resolved** currency scope. Splitting them is what makes the
compiler refuse a read path that dispatches without resolving.

Files added under `apps/api-gateway/src/modules/catalog/`:

-
`application/use-cases/{set-price,list-prices,get-applicable-price,create-tax-category,list-tax-categories,attach-variant-tax-category}.use-case.ts`
- `presentation/dto/{set-price.request,price-query,create-tax-category.request,attach-tax-category.request}.dto.ts`

and the port/adapter/controller/module/barrels were extended.

## 5. Request DTOs (edge guards only)

The DTOs are the gateway's edge guard — a malformed request fails fast with a `400`
before any RPC is dispatched; the pricing domain has the **final** say on every
invariant.

- `SetPriceRequestDto` — `currency` (`^[A-Z]{3}$`), `amountMinor` (`@IsInt @Min(0)`,
  integer minor units / cents), `validFrom?` / `validTo?` (`@IsISO8601`),
  `priority?` (`@IsInt`). One body backs both Set and Schedule.
- `PriceQueryDto` — `currency` (optional, `^[A-Z]{3}$`; the default is resolved in
  the use case from `CATALOG_GATEWAY_DEFAULT_CURRENCY`, §3), `asOf` (field default
  = now); shared by the two price GETs.
- `CreateTaxCategoryRequestDto` — `code` (`^[A-Z][A-Z0-9_]*$`), `name`
  (`1..255`), `description?` (`≤1000`).
- `AttachTaxCategoryRequestDto` — `taxCategoryCode` (`^[A-Z][A-Z0-9_]*$`).

## 6. End-to-end proof (`test/pricing.e2e-spec.ts`)

The slice is proven end-to-end through the gateway, self-contained (it registers
its own draft product + variants via the catalog write routes — it does **not**
rely on any seeded price):

1. Register a draft product + two variants.
2. Publish with **no price** → **`409`** (`PRODUCT_PUBLISH_REQUIRES_PRICE`); the
   product stays `draft`.
3. Set a `USD` price for each variant → `201` `PriceView`.
4. Publish → `200`, `status: active`.
5. An anonymous shopper reads the current applicable price.
6. Schedule a higher-priority future price (`validFrom = now+1h`): the *current*
   answer is unchanged; `?asOf=now+2h` returns the future price.
7. Set a new immediate price: the predecessor is closed (`validTo == newPrice
   .validFrom`, half-open tiling); a historic `?asOf` still returns the old price.
8. Tax categories: create → duplicate `409` → public list → attach to a variant.
9. **Concurrency:** two `POST .../prices` for the same `(variantId, currency)`
   fired together leave **at most one** open (`valid_to IS NULL`) row for the scope
   — the `open_scope_key` UNIQUE backstop + the close-in-transaction. At least one
   call wins; any loser is a clear error, never a silent second open row.
10. Auth gates: staff-without-`pricing:write` → `403`, customer token → `403`,
    no token → `401`, public reads → `200`.

### A timezone correctness fix surfaced by the live flow

Step 4 (publish *after* pricing through the gateway) surfaced a latent persistence
bug. The MySQL server runs in UTC, and the publish precondition probe compares the
stored `price.valid_from` against `UTC_TIMESTAMP()`
([04 — publish precondition](04-publish-precondition-hard-fail.md)). But the
`mysql2` driver defaulted to the **Node host's local timezone**, so a price written
through the domain (`new Date()`) was stored as *local* wall-clock — seven hours
off `UTC_TIMESTAMP()` on a UTC+7 host — and the freshly-priced product still failed
to publish. (The catalog e2e never saw this because it seeds prices via raw SQL
`valid_from = UTC_TIMESTAMP()`, which is already UTC.)

The fix pins the driver to UTC in `libs/database/database.module.ts`
(`timezone: 'Z'`), so JS `Date`s are written and read as UTC wall-clock, matching
the server clock and `UTC_TIMESTAMP()`. This also corrects how DB-generated
(`CURRENT_TIMESTAMP`) values are read back on a non-UTC host. It honors
[ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md) (the connection is
configured once in `DatabaseModule.forRoot`).

The price columns are second-granular (`TIMESTAMP(0)`), so MySQL rounds a
sub-second `validFrom` to the nearest whole second — a just-set immediate price can
round *up* and momentarily sit one second ahead of `UTC_TIMESTAMP()`. The e2e waits
just over a second between the last price Set and the publish (the realistic "price
first, publish later" gap) so the precondition is deterministically met.

## 7. Kulala HTTP exercises (`http/kulala/pricing.http`)

[`http/kulala/pricing.http`](../../../http/kulala/pricing.http) is a runnable, top-to-bottom
Kulala collection for the six routes. It mirrors the conventions of
[`http/kulala/catalog.http`](../../../http/kulala/catalog.http): `@baseUrl = {{ENV_BASE_URL}}`
(resolved from [`http/kulala/http-client.env.json`](../../../http/kulala/http-client.env.json)),
`###`-separated blocks, a `# @name <id>` per request, and header comments citing
the controller path, the body/query shape, and the auth posture.

### The flow

| # | `# @name`                    | Method · path                                 | Auth   | What it proves                                               |
|---|------------------------------|-----------------------------------------------|--------|--------------------------------------------------------------|
| 1 | `login`                      | `POST /auth/staff/login`                      | —      | Seeded admin (`admin@example.com`) → captures `@accessToken` |
| 2 | `createTaxCategory`          | `POST /catalog/tax-categories`                | Bearer | Creates the non-seed `LUXURY` label                          |
| 3 | `listTaxCategories`          | `GET /catalog/tax-categories`                 | public | The created label appears, no token                          |
| 4 | `setPriceVariant1`           | `POST /catalog/variants/1/prices`             | Bearer | Immediate Set (USD 4999, `validFrom` omitted)                |
| 5 | `listPricesVariant1`         | `GET /catalog/variants/1/prices?currency=USD` | public | Every row in effect now                                      |
| 6 | `getApplicablePriceVariant1` | `GET /catalog/variants/1/price?currency=USD`  | public | The single applicable row now                                |
| 7 | `schedulePriceVariant1`      | `POST /catalog/variants/1/prices`             | Bearer | A future-`validFrom` schedule                                |
| 8 | `attachTaxCategoryVariant1`  | `PATCH /catalog/variants/1/tax-category`      | Bearer | Attaches `LUXURY` to variant 1                               |

Run the `login` block first: it captures the seeded admin's bearer token into
`@accessToken`, which every write substitutes into its `Authorization` header. The
three GETs send no token, so they double as proof the `@Public()` reads work
unauthenticated (and that the writes `401` without the bearer). The file targets
the seeded catalog variants (1 `AURORA-WARM` … 4 `NIMBUS-GREY`) and drives variant
`1`.

### Why it Sets before it Gets (self-containment)

The price and tax **seed rows did not exist** when this file was written — the
pricing seed was added later alongside the rest of the seed data, and the e2e
never depends on a seeded price either. So the collection cannot assume any price
or tax category is already present: it **Creates a tax category before it
lists/attaches one** (block 2 before 3 and 8) and **Sets a price before it
lists/resolves one** (block 4 before 5 and 6). A non-seed code, `LUXURY`, is
chosen for the create so the block stays runnable on a freshly-seeded database
where a seeded `STANDARD` / `REDUCED` / `EXEMPT` set might later exist — a repeat
run against the same DB would `409` on the duplicate `code`, which is why a second
top-to-bottom pass wants a fresh DB (`yarn test:infra:reload`).

**Those seeds have since landed, and the ordering above is what keeps the file
running anyway.** `yarn test:seed` now applies `scripts/seeds/tax-category.sql`
(`STANDARD` / `REDUCED` / `EXEMPT` — code + name, no rate) and
`scripts/seeds/price.sql` (one **open** USD row per seeded variant 1–4: `4999` for
the lamp pair, `19999` for the chair pair, all with a fixed
`valid_from = 2020-01-01` so the seed is deterministic and idempotent). Three
consequences for a hand run:

- `createTaxCategory` still succeeds — `LUXURY` is deliberately outside the seeded
  set — and `listTaxCategories` now returns **four** rows, not one.
- `setPriceVariant1` still succeeds: variant 1's seeded row opened in 2020, which
  is strictly before the new `validFrom`, so `resolvePredecessor` closes it and
  appends rather than raising `PRICE_SCHEDULE_CONFLICT`.
- `getApplicablePriceVariant1` therefore answers with the *block-4* price, not the
  seeded `4999` — same `priority` `0`, later `validFrom` wins the tiebreak.

The file's own header comment still says it "assumes NO price/tax seed rows"; that
sentence is stale, the ordering it justifies is not.

### The future-`validFrom` scheduling demonstration

Block 7 reuses the **same** `POST .../prices` route and body as the immediate Set
in block 4 — the only difference is a `validFrom` ahead of now, which is what turns
a Set into a Schedule (§1, `SetPriceUseCase` handles both). Appending it closes the
open predecessor (block 4's price) at the new `validFrom`, tiling the timeline so
exactly one row stays open per `(variantId, currency)` scope (the `open_scope_key`
invariant — a second *open* row would conflict).

The demonstration is the **time-travel read**: immediately after scheduling, block
6 (`?asOf` defaulting to now) still returns the block-4 immediate price — the
scheduled row is not yet in effect. Re-running that GET with `?asOf` at or after
the scheduled `validFrom` returns the scheduled price instead. The file pins a
comfortably-future fixed instant so it runs as-is, and its header comment documents
computing a realistic `~1h`-ahead UTC ISO-8601 timestamp
(`date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%S.000Z`) for a live "schedule, then watch
it activate" walkthrough. (A `validFrom` strictly in the past is rejected by the
domain with `PRICE_VALID_FROM_IN_PAST`, so the scheduled instant must be in the
future.)

`test/pricing.e2e-spec.ts` remains the automated reference for the same
request/response shapes and the full auth posture; `http/kulala/pricing.http` is the
hand-runnable companion.

A **Posting mirror** of the same eight requests was added later under
`http/posting/pricing/` — same order, same captures, a different runner. Kulala
chains declaratively (`{{login.response.body.$.accessToken}}`); Posting has no such
reference, so the producer blocks carry `on_response` hooks in
`http/posting/pricing/scripts.py` that call `posting.set_variable(...)`, and
consumers read `$accessToken`. Run it from the collection root:
`posting --collection http/posting --env http/posting/dev.env`.
