# 05 — Set / Schedule / Select Applicable Price

This document records the pricing module's write/read **application layer and its
RPC surface**: setting and scheduling a price through one use case, listing the
prices in effect, and the deterministic *Select Applicable Price* resolution that
answers "what does this variant cost, in this currency, at this instant?" with a
single row. It builds on the domain and persistence in
[02 — The `Price` domain and the append-only history](02-price-domain-and-append-only-history.md)
and is governed by
[ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md). It also
honors [ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md) (dotted routing
keys, `ROUTING_KEYS` in lock-step with `MicroserviceMessagePatternEnum`),
[ADR-011](../../adr/011-notifier-port-and-adapters.md) /
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md) (cross-service events
are framework-free interfaces; `ClientProxy` lives only in
`infrastructure/messaging`; post-commit publish is best-effort), and
[ADR-001](../../adr/001-structured-logging-with-pino.md) (inline `correlationId`
inside RPC handlers).

The code lives under `apps/catalog-microservice/src/modules/pricing/`. The pricing
module colocates with the catalog microservice and shares `catalog_queue`
(ADR-026), so these RPCs register on the same queue as the catalog ones.

## 1. Set and Schedule are one use case

Setting a price *now* and scheduling one *for later* are the same operation with
one parameter different: **when the new interval starts.** So they share one use
case (`SetPriceUseCase`), one RPC (`catalog.price.set`), and (later) one gateway
endpoint. The only branch is at the very end — which event is emitted.

`SetPriceUseCase.execute(payload)` does this:

1. **Build the domain `Price`.** `Price.set({ variantId, currency, amountMinor,
   validFrom?, validTo?, priority })` with `now` captured once. `validFrom`
   omitted ⇒ "now" (an immediate price). The domain rejects a `validFrom`
   strictly before now (`PRICE_VALID_FROM_IN_PAST`), a bad currency/amount/
   priority, and an inverted interval — so a malformed command never reaches the
   repository.
2. **Find the open predecessor.** `repo.findOpenPrice(variantId, currency)` — the
   single open (`validTo IS NULL`) row for the scope, or `null`.
3. **Decide what to close** (`resolvePredecessor`):
   - `open === null` → nothing to close; this is the first price for the scope.
   - `open.validFrom < newPrice.validFrom` → close it **at** the new `validFrom`
     (`open.close(newPrice.validFrom)`). The predecessor's interval becomes
     `[open.validFrom, newPrice.validFrom)` and the successor's is
     `[newPrice.validFrom, …)` — they tile without overlap.
   - otherwise (`open.validFrom >= newPrice.validFrom`) → reject with
     `PRICE_SCHEDULE_CONFLICT`. A new interval cannot begin at or before an
     already-open one; see [§4](#4-the-schedule-conflict-and-its-deliberate-limit).
4. **Append atomically.** `repo.appendPrice(newPrice, predecessorToClose)` runs the
   close-UPDATE and the insert in one transaction and re-reads the inserted row so
   its concrete id comes back (ADR-026 §3).
5. **Emit, best-effort, post-commit.** If `saved.validFrom > now` the price is in
   the future → emit `catalog.price.scheduled` (with `effectiveAt == validFrom`);
   otherwise → `catalog.price.changed`. A broker failure is warn-logged and
   swallowed — the row is already persisted (ADR-020).
6. **Return** the persisted row as a `PriceView`.

Because the immediate/scheduled decision is `validFrom > now`, an immediate price
(whose `validFrom` defaulted to the same `now`) is never mistaken for a scheduled
one, and the two events stay cleanly separated.

### Why scheduling leaves the current price untouched

The subtle, important property: scheduling a future price must **not** change what
the variant costs *right now*. It doesn't, by construction. When you schedule a
price at future instant `F`, the predecessor is closed *at* `F`, so its interval
becomes `[past, F)` — which still contains "now". The scheduled row's interval is
`[F, …)`, which does not contain "now" yet. So a resolution at "now" still returns
the predecessor; only once the clock passes `F` does the scheduled row win. No
job, no cron, no flip — the answer changes because the intervals say so.

```
amount  ──1500────────────────┐ (predecessor, closed at F)
                              │
        ──2500─ ─ ─ ─ ─ ─ ─ ─ ┴───────────►  (scheduled, open: [F, ∞))
        validFrom=T0     now   F
        resolve(now) → 1500          resolve(after F) → 2500
```

## 2. Select Applicable Price — the resolution

`SelectApplicablePriceUseCase` answers `(variantId, currency, asOf) → one Price |
null`. It is the seam the GET single-price endpoint and (later) the publish
precondition both consume. `asOf` defaults to "now".

```
candidates = repo.findInEffect(variantId, currency, asOf)   // coarse filter
applicable = resolve(candidates)                            // the policy
return applicable === null ? null : toPriceView(applicable)
```

Two steps, two responsibilities:

- **Interval containment is the repository's coarse filter.**
  `findInEffect(variantId, currency, asOf)` returns every row whose half-open
  interval `[validFrom, validTo)` contains `asOf`: `validFrom <= asOf AND (validTo
  IS NULL OR validTo > asOf)`. Half-open means the end is **exclusive** — a row
  whose `validTo` equals `asOf` is already out, so adjacent intervals never both
  match at the boundary instant.
- **The pick policy is the use case's.** From the candidate set, `resolve`
  chooses:
  1. **highest `priority`** wins;
  2. on a tie, **latest `validFrom`** (the most recently started interval) wins.

  `resolve` is a pure static method (`SelectApplicablePriceUseCase.resolve`), so
  it is reasoned about and tested without an instance, and returns `null` for an
  empty set.

`ListPricesUseCase` (`catalog.price.list`) shares the same `findInEffect` coarse
set but skips the collapse — it returns *every* in-effect row as `PriceView[]`, so
an operator can see what resolution is choosing between (overlapping priorities
included).

### Why the resolution lives in the use case, not in SQL

It would be tempting to push "highest priority, then latest validFrom" into the
`ORDER BY … LIMIT 1` of the query — the database already has the rows. We
deliberately do not, for two reasons:

- **Unit-testability without a database.** The policy is the part most likely to
  grow (a future channel/customer-group axis would extend the tiebreak). Keeping
  it in TypeScript means it is exercised by `select-applicable-price.use-case.spec.ts`
  against an in-memory repository double — no MySQL, no migration, milliseconds
  per case. The double's `findInEffect` returns candidates **unsorted** (insertion
  order) precisely so the spec proves the *use case* does the sorting; had the
  policy leaked into the query, an unsorted candidate set would surface the bug.
- **Freedom to evolve schema-free.** The query stays a stable, index-backed
  "rows whose interval contains `asOf`" filter (`IDX_PRICE_RESOLVE (variant_id,
  currency, valid_from DESC)` orders as a convenience). Changing the pick policy
  is a code change with a unit test, not a migration.

This mirrors the catalog convention where the read projection lives in a
`*-view.factory.ts` rather than in SQL.

## 3. Worked fixtures

All amounts are minor units (integer cents). `asOf` is an instant; intervals are
`[validFrom, validTo)`.

### Overlapping priorities — a promo over a base price

| id | amount | interval | priority |
| --- | --- | --- | --- |
| 1 | 1000 | `[2020-01-01, ∞)` | 0 |
| 2 | 800 | `[2026-01-01, 2027-01-01)` | 10 |

- `resolve(asOf = 2026-06-01)` → both rows are in effect; row 2 has the higher
  priority → **800**.
- `resolve(asOf = 2027-06-01)` → only row 1 is in effect (row 2's interval
  ended) → **1000**.

### The tiebreak — equal priority, latest start wins

| id | amount | interval | priority |
| --- | --- | --- | --- |
| 3 | 700 | `[2026-01-01, 2027-01-01)` | 5 |
| 4 | 650 | `[2026-03-01, 2027-01-01)` | 5 |

- `resolve(asOf = 2026-06-01)` → both in effect, same priority → the later
  `validFrom` (row 4) wins → **650**.

### A scheduled future row — the current answer holds until the changeover

Start with an open row `1500` over `[2020-01-01, ∞)`. Schedule `2500` at
`F = 2099-06-01`. After `SetPriceUseCase`:

| id | amount | interval | note |
| --- | --- | --- | --- |
| 1 | 1500 | `[2020-01-01, 2099-06-01)` | predecessor, **closed at F** |
| 2 | 2500 | `[2099-06-01, ∞)` | scheduled, open |

- `resolve(asOf = 2030-01-01)` → **1500** (only the predecessor contains it).
- `resolve(asOf = 2099-12-01)` → **2500** (only the scheduled row contains it).

`catalog.price.scheduled` was emitted with `effectiveAt = 2099-06-01`.

### Empty result → `null`

| id | amount | interval | priority |
| --- | --- | --- | --- |
| 7 | 1000 | `[2026-01-01, 2026-02-01)` | 0 |

- `resolve(asOf = 2025-01-01)` → no interval contains it → **`null`**.
- A scope with no rows at all → **`null`**.

`catalog.price.select` returns `null` (not an error) when nothing is in effect —
"this variant has no price right now" is a valid, expected answer.

## 4. The schedule conflict and its deliberate limit

`SetPriceUseCase` rejects with `PRICE_SCHEDULE_CONFLICT` when the existing open row
starts **at or after** the new row's `validFrom`. Two cases produce it:

- An immediate Set while a *future* price is already open (the open row starts
  after now).
- A second Set/Schedule at an instant at-or-before the open row's start.

This is a **deliberate limitation, not an oversight.** This capability has no
cancel-or-reschedule flow: there is exactly one open row per scope, and the only
way to move the timeline forward is to append a row that starts strictly *after*
the current open one. Replacing or cancelling a pending scheduled price is a
future capability; until it exists, the conflict is surfaced as a typed `409` so
the caller gets a clear, well-formed rejection rather than a silent overwrite or a
raw open-scope UNIQUE-violation from the database.

## 5. The RPC surface, contracts, and events

Three RPCs on `catalog_queue`, handled by `PricingController`
(`presentation/pricing.controller.ts`), each a thin translation into a use case:

| Routing key | Handler | Returns |
| --- | --- | --- |
| `catalog.price.set` | `SetPriceUseCase` | `PriceView` |
| `catalog.price.list` | `ListPricesUseCase` | `PriceView[]` |
| `catalog.price.select` | `SelectApplicablePriceUseCase` | `PriceView \| null` |

Two events, emitted post-commit by `PricingRabbitmqPublisher`
(`infrastructure/messaging/` — the **only** `ClientProxy` holder in pricing):

| Routing key | When |
| --- | --- |
| `catalog.price.changed` | an immediate price was appended (`validFrom <= now`) |
| `catalog.price.scheduled` | a future price was appended (`validFrom > now`); carries `effectiveAt` |

Both events ride `catalog_queue` with **no cross-service consumer yet** — a later
audit / event-store capability binds them. The five routing keys
(`catalog.price.set/list/select/changed/scheduled`) live in **both**
`ROUTING_KEYS` (`libs/messaging`) and `MicroserviceMessagePatternEnum`
(`libs/contracts`), kept value-for-value (asserted by
`routing-keys.constants.spec.ts`).

The wire contracts (`libs/contracts/catalog/`) are framework-free; events extend
`ICorrelationPayload` + `occurredAt`, timestamps cross as ISO-8601 strings:

- `IPriceSetPayload` — the `catalog.price.set` command (`variantId`, `currency`,
  `amountMinor`, optional `validFrom`/`validTo`/`priority`).
- `IPriceQuery` — shared by list and select (`variantId`, `currency`, optional
  `asOf`).
- `PriceView` — a **class** with `@ApiResponseProperty` (the documented
  lib-contracts Swagger exception, ADR-017) so the gateway can declare it as
  `@ApiOkResponse({ type: PriceView })`, mirroring `ProductView`.
- `ICatalogPriceChangedEvent` / `ICatalogPriceScheduledEvent` — the two `v1` wire
  events; scheduled is changed + `effectiveAt`.

### Error mapping

`PricingRpcExceptionFilter` (registered via `APP_FILTER`) maps each
`PricingErrorCodeEnum` onto an HTTP status so the gateway resolves the right code
instead of collapsing everything to 500. The map is a *total* `Record` — a new
code fails the build until given a status:

- `PRICE_SCHEDULE_CONFLICT`, `TAX_CATEGORY_CODE_TAKEN` → **409**
- `TAX_CATEGORY_NOT_FOUND`, `VARIANT_NOT_FOUND` → **404**
- the validation codes (`PRICE_AMOUNT_INVALID`, `PRICE_CURRENCY_INVALID`,
  `PRICE_INTERVAL_INVALID`, `PRICE_VALID_FROM_IN_PAST`, `PRICE_PRIORITY_INVALID`,
  `TAX_CATEGORY_CODE_INVALID`, `TAX_CATEGORY_NAME_REQUIRED`) → **400**

## 6. The reserved pricing cache-key builder

`CACHE_KEYS.catalogPrice*` (`libs/cache/cache-keys.ts`) is added but **not
consumed**: keyed on `(variantId, currency)` — the entire price scope — with shape
`ris:[t:<tenantId>:]catalog:price:v1:<variantId>:<currency>` and a
`CATALOG_PRICE_KEY_VERSION` constant a breaking DTO change would bump (ADR-022).
The pricing module does **not** import `CacheModule`: the threshold for caching
pricing reads is unmet, and a Select-Applicable resolution over a handful of
candidate rows is cheap. The builder exists so a future cached read path adopts
the locked v1 key shape without re-keying — the same reserved-but-unconsumed
stance the `catalogProduct*` builder takes.

## What this does not do

There is **no** active-Price publish hard-fail yet — `catalog.product.publish`
still does not block a price-less product; `select-applicable` is the seam that
precondition will consume, completed in a later document in this folder. There are
**no** gateway HTTP routes for these RPCs and **no** `.http` file yet, and **no**
tax-category use cases or variant attach use case (its FK column and repository
methods exist — see
[03 — `TaxCategory` and variant attachment](03-tax-category-and-variant-attachment.md)).
Each lands as the pricing context grows.
