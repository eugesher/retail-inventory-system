---
epic: epic-00
task_number: 12
title: Add ADR-012 forward-supersession pointers for `StockCache` port + adapter evolution (ADR-016/021/022/023 + `ITransactionPort`)
depends_on: []
doc_deliverable: null
---

# Task 12 — Fold five ADR-012 stale-narrative items into a supersession-pointer amendment

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-012 in full, then ADR-016 (cache-aside generalized), ADR-021 (single-flight + TTL jitter), ADR-022 (tenant + schema-version cache keys), ADR-023 (post-commit invalidation type-enforced), ADR-003 (ADR cadence / immutability), and CLAUDE.md §"Operational notes" (the open `ARCH-LINT-EX-01` `EntityManager` exception that the ITransactionPort partially rings-fences). The live `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts` and `application/ports/` are the source of truth for the drifts noted below.

## ADR audited

[ADR-012 — Stock aggregate and the inventory port/adapter split](../../../docs/adr/012-stock-aggregate-and-port-adapter.md). Accepted (2026-05-13).

## Discrepancy

Five claims in ADR-012 have drifted from the live code. None of them is load-bearing in isolation — all five describe the **stock cache port and its adapter** as that surface existed immediately after task-08 of the original Plan-A migration, before ADR-016, ADR-021, ADR-022, and ADR-023 generalized the cache contract. Per the user's audit guidance (stale-narrative items get folded into one supersession-pointer amendment per ADR), they are consolidated into this single task.

Surface: `docs/adr/012-stock-aggregate-and-port-adapter.md` (the ADR prose itself).

This is **CODE-DISCREPANCY (stale narrative)**, not a contradiction of a still-binding rule. The original ADR-012 binding rules — single `stock` bounded context, `StockItem` as a pure class with its three invariants, `Storage` as a `ValueObject<{id:string}>`, events extending `DomainEvent<number>`, the port/adapter split, events emitted from the use case, the reserved `EXCHANGES.NOTIFICATION` constant — all hold in the live code (verified in the audit run that produced this task).

## Evidence

### (1) §3 — cache adapter is named `StockRedisCache`. Live class is `StockCache`.

ADR-012 §3 (`docs/adr/012-stock-aggregate-and-port-adapter.md:66-70`):

```text
- `IStockCachePort` (DI symbol `STOCK_CACHE`) — stock-specific cache port,
  hides the cache-key shape from use cases. Adapter: `StockRedisCache`,
  which reaches through `@nestjs/cache-manager` + `@keyv/redis` and
  preserves the ADR-002 SCAN+UNLINK contract verbatim (named-key
  fallback for non-Redis backends).
```

Live class (`apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts:22`):

```ts
@Injectable()
export class StockCache implements IStockCachePort {
```

The file is `stock.cache.ts`, not `stock-redis.cache.ts`; the class is `StockCache`, not `StockRedisCache`. The rename happened after the cache adapter was generalized off direct `@nestjs/cache-manager` / `@keyv/redis` use — once Redis-specific code moved into `libs/cache`, the `Redis` qualifier no longer matched the file's responsibility.

### (2) §3 — cache adapter "reaches through `@nestjs/cache-manager` + `@keyv/redis`". Live adapter delegates to `CACHE_PORT`.

Same ADR-012 §3 block as above. Live constructor (`stock.cache.ts:5,27-33`):

```ts
import { CACHE_KEYS, CACHE_PORT, ICachePort } from '@retail-inventory-system/cache';
…
constructor(
  @Inject(CACHE_PORT)
  private readonly cache: ICachePort,
  private readonly configService: ConfigService,
  @InjectPinoLogger(StockCache.name)
  private readonly logger: PinoLogger,
) {}
```

ADR-016 (`docs/adr/016-cache-aside-generalized.md`) generalized the cache port to a `CACHE_PORT`-shaped surface used by every stock cache operation. CLAUDE.md §"Cache-key convention" (line referencing ADR-022) makes this binding: "Apps MUST NOT import `@nestjs/cache-manager`, `@keyv/redis`, or the `cacheable` package directly — depend on `ICachePort`/`CACHE_PORT`." The ADR-012 description still names the now-forbidden import path as the adapter's mechanism.

### (3) §3 — "preserves the ADR-002 SCAN+UNLINK contract verbatim (named-key fallback for non-Redis backends)". Live adapter uses `delByPrefix` + `withInvalidation`.

Same ADR-012 §3 block as above. Live invalidation path goes through `IStockCachePort.withInvalidation` and ultimately `ICachePort.delByPrefix`:

`apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts:43-46,57-61`:

```ts
// ADR-023: no public `invalidate(...)`. `withInvalidation` runs `work`
// first and only then fires the internal prefix delete, so the post-commit
// ordering is type-enforced — invalidating from inside a transaction
// callback is not expressible.
export interface IStockCachePort {
  …
  withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T>;
}
```

ADR-016 added `delByPrefix` to `ICachePort`; ADR-023 made the post-commit ordering type-enforced. Neither SCAN+UNLINK as a code path nor the "named-key fallback for non-Redis backends" survives in the adapter. The named-key fallback was a property of the legacy `CacheHelper`-shaped adapter — once the adapter delegates to `CACHE_PORT.delByPrefix`, the fallback is the responsibility of `RedisCacheAdapter` in `libs/cache` (or a future non-Redis adapter), not `StockCache`.

### (4) §3 — "Three application ports, three concrete adapters". Live `application/ports/` has four ports.

ADR-012 §3 (`docs/adr/012-stock-aggregate-and-port-adapter.md:60`):

```text
### 3. Three application ports, three concrete adapters
```

Live `apps/inventory-microservice/src/modules/stock/application/ports/` (per `ls`):

```
index.ts
stock-cache.port.ts
stock-events.publisher.port.ts
stock.repository.port.ts
transaction.port.ts        ← added after ADR-012 to ring-fence ARCH-LINT-EX-01
```

The fourth port — `transaction.port.ts` — was introduced as the partial close of CLAUDE.md §"Operational notes" `ARCH-LINT-EX-01` (the `EntityManager`-leaks-across-the-port issue). The port appears in `IStockRepositoryPort` method signatures as `scope?: ITransactionScope` (live code, `stock.repository.port.ts:34-46`). ADR-012's "three ports" framing predates this addition.

(Note: ARCH-LINT-EX-01 itself remains open per CLAUDE.md — the exception calls out that closing it "requires introducing an `ITransactionPort` abstraction that replaces both suppressions in lock-step — left as a follow-up". The introduction of `transaction.port.ts` is the first half of that close; the second half — removing the inline ESLint disables — is still pending. The ADR-012 amendment should note the ITransactionPort is present but the exception is not yet fully closed.)

### (5) §4 + §8 — "post-commit fire-and-forget invalidation" + "AUDIT-2026-05-08 [CACHE-NNN] annotations preserved verbatim". Both superseded.

ADR-012 §4 (`docs/adr/012-stock-aggregate-and-port-adapter.md:90-95`):

```text
The cache-aside read path, the transactional reserve path, the
post-commit fire-and-forget invalidation, the `AUDIT-2026-05-08
[CACHE-001/CODE-001]` annotations — all preserved verbatim in the new
use cases. Only the file layout and the *shape* of the abstractions
change.
```

ADR-012 §8 (`docs/adr/012-stock-aggregate-and-port-adapter.md:139-146`):

```text
### 8. Cache audit annotations preserved verbatim

Every `AUDIT-2026-05-08 [CACHE-NNN]` and `AUDIT-2026-05-08 [CODE-NNN]`
comment from the legacy code travels with its production line into the
new module. Line numbers update where the surrounding code moved, but
the textual content and the audit identifier do not. Task-11 owns the
generalization pass for these items; this ADR explicitly does not.
```

Live `stock.cache.ts:17-20`:

```ts
// Audit closures: CACHE-001/004 by ADR-021 (single-flight + jitter),
// CACHE-003/009 by ADR-022 (schema-version + opt-in tenant segments),
// CACHE-005 by the `available` flag from `get` (Redis-down request emits
// one warn instead of three).
```

CLAUDE.md §"Operational notes" confirms the closure: "All audit items from `docs/audits/audit-2026-05-08.md` are closed: CACHE-006, CACHE-010, CACHE-011, CACHE-012 by ADR-016; CACHE-001 and CACHE-004 by ADR-021; CACHE-003 and CACHE-009 by ADR-022; CACHE-002 by [ADR-023](…); CACHE-005 by the `IStockCachePort.get` return shape carrying an `available` flag…". The "preserved verbatim" claim of ADR-012 §4 + §8 is exactly the surface that ADR-016/021/022/023 (the "generalization pass" §8 promised) replaced. The only `AUDIT-2026-05-08` annotation that remains in the stock module is `[CODE-001]` inside `reserve-stock-for-order.use-case.ts:129` (verified by `grep -rn "AUDIT-2026-05-08" apps/inventory-microservice/src/modules/stock/`).

The post-commit ordering is no longer "fire-and-forget" — it is the type-enforced `withInvalidation` of ADR-023. The §4 phrasing is stale.

## Why this matters

ADR-012 is the per-module hexagonal realization for the inventory microservice. A reader who lands on it and follows the `StockRedisCache` / `@nestjs/cache-manager` / SCAN+UNLINK / fire-and-forget breadcrumbs will hit one of two failure modes:

1. **Following the description literally.** They will look for a `stock-redis.cache.ts` file (does not exist), find no SCAN+UNLINK code path (gone), and conclude the code has drifted from the ADR. The opposite is true — the ADR is the thing that has drifted, by way of four explicit later ADRs generalizing its surface.
2. **Importing the forbidden packages.** A new stock-adjacent feature that uses `@nestjs/cache-manager` directly (because ADR-012 §3 says the cache adapter does) trips both ADR-016 ("apps depend on `ICachePort`/`CACHE_PORT`") and the architecture-lint boundaries rule of ADR-017.

The same supersession-pointer amend pattern is already filed for ADR-001 (epic-00/task-01), ADR-002 (epic-00/task-02), ADR-006 (epic-00/task-05), ADR-007 (epic-00/task-06), ADR-008 (epic-00/task-07), and ADR-004 (epic-00/task-04). ADR-012 is the next in line.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-012's `**Status**` line + add a `## References` section with five forward-supersession bullets (recommended).**

ADR-003 §"Status flips" permits flipping the status and adding a one-line pointer. ADR-012 has no `## References` section today; this task adds one. Concrete edits:

- Replace `**Status**: Accepted` with `**Status**: Accepted (cache port + adapter generalized by [ADR-016](016-cache-aside-generalized.md) / [ADR-021](021-cache-single-flight-and-ttl-jitter.md) / [ADR-022](022-cache-keys-tenant-and-schema-version.md) / [ADR-023](023-cache-invalidate-post-commit-by-type.md); fourth `ITransactionPort` added to ring-fence `ARCH-LINT-EX-01`)`.
- Add a new `## References` section at the bottom of the file with five bullets — one per drift — pointing forward to the superseding ADR (or, for the class-name and ports-count items, to the live file paths):
  - **§3 cache adapter name.** Live class is `StockCache` at `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`; the `Redis` qualifier was dropped when the adapter stopped reaching `@nestjs/cache-manager`/`@keyv/redis` directly (next bullet).
  - **§3 cache adapter implementation.** Generalized by [ADR-016](016-cache-aside-generalized.md). The adapter now delegates to `CACHE_PORT` from `@retail-inventory-system/cache`; direct imports of `@nestjs/cache-manager` / `@keyv/redis` are forbidden in apps per CLAUDE.md §"Cache-key convention".
  - **§3 SCAN+UNLINK + named-key fallback.** Generalized by [ADR-016](016-cache-aside-generalized.md) (`delByPrefix` primitive on `ICachePort`) and [ADR-023](023-cache-invalidate-post-commit-by-type.md) (post-commit ordering type-enforced via `IStockCachePort.withInvalidation`). The named-key fallback for non-Redis backends is now the responsibility of the concrete `CACHE_PORT` adapter, not `StockCache`.
  - **§3 "three application ports".** The stock module's `application/ports/` now has four files: a `transaction.port.ts` (introduced to ring-fence the `ARCH-LINT-EX-01` `EntityManager` leak per CLAUDE.md §"Operational notes") joined the three listed here. The fourth port is partial — closing `ARCH-LINT-EX-01` fully is still pending.
  - **§4 / §8 "preserved verbatim" of `AUDIT-2026-05-08 [CACHE-NNN]` annotations + fire-and-forget invalidation.** The audit items the annotations referenced are now closed: CACHE-001/004 by [ADR-021](021-cache-single-flight-and-ttl-jitter.md), CACHE-003/009 by [ADR-022](022-cache-keys-tenant-and-schema-version.md), CACHE-005 by the `available` flag on `IStockCachePort.get`, CACHE-002 by [ADR-023](023-cache-invalidate-post-commit-by-type.md) (post-commit ordering type-enforced — no public `invalidate`, no fire-and-forget). CLAUDE.md §"Operational notes" carries the closure register.

Do **not** rewrite the §3 / §4 / §8 prose in place. The Nygard immutability rule of ADR-003 keeps the historical decision text intact; the `## References` section is the forward graph for a reader to follow.

**Option B — Rewrite §3, §4, and §8 in place to match the live shape.**

Mechanically simpler for a future reader but violates ADR-003's immutability promise. Sets a precedent that erodes trust in the ADR set — historical context disappears in the rewrite, and the "decision at time of writing" is no longer recoverable. Rejected as the recommendation.

If option B is chosen anyway, the rewrites must (a) preserve the rationale paragraphs (the *why* of each decision was correct at the time), (b) replace only the names and the mechanism descriptions, and (c) carry an inline footnote linking forward to ADR-016/021/022/023 for each rewrite.

## Scope

**In:**

- Edit `docs/adr/012-stock-aggregate-and-port-adapter.md`:
  - Flip the `**Status**` line per option A.
  - Add a new `## References` section after `## Alternatives considered` with the five bullets above.

**Out:**

- Any change to live code in `apps/inventory-microservice/` or `libs/cache/`.
- Closing the `ARCH-LINT-EX-01` exception (the second half — removing the inline ESLint disables — is its own follow-up).
- Any change to ADR-016/021/022/023 (they are the forward-pointed-to ADRs, not the ones being amended).
- Any change to CLAUDE.md (its §"Operational notes" already enumerates the closures correctly).

## Exit criteria

- [ ] `docs/adr/012-stock-aggregate-and-port-adapter.md`'s `**Status**` line carries the four forward-supersession pointers (or follows option B with inline footnotes).
- [ ] `docs/adr/012-stock-aggregate-and-port-adapter.md` has a `## References` section with the five bullets (or the equivalent inline footnotes in option B).
- [ ] `grep -n "StockRedisCache" docs/adr/012-stock-aggregate-and-port-adapter.md` returns only matches inside the historical §3 prose (option A) or no matches (option B).
- [ ] `yarn lint` still passes (this task edits only `docs/adr/*.md`).
- [ ] `tmp/adr-verification-progress.md` ADR-012 row reflects this task's findings.
