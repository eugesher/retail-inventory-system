# `_fix-cache-stampede-and-jitter` — summary

> Carryover for `docs/tasks/fix-cache-stampede-and-jitter.md`. Closes
> audit items **CACHE-001** (cache-aside read/write race / cache stampede)
> and **CACHE-004** (no TTL jitter) per `docs/audits/audit-2026-05-20-followup.md`.

## Status

**DONE.** All acceptance criteria met. Verification gate passes (install,
build, lint with `--max-warnings 0`, 161/161 unit tests, forbidden-import
grep returns zero matches).

## Files edited

- `libs/cache/cache.port.ts` — added `singleFlight<T>(key, fn): Promise<T>`
  to `ICachePort` with inline contract comment.
- `libs/cache/redis-cache.adapter.ts` — implemented `singleFlight` against
  an in-process `Map<string, Promise<unknown>>`; entries cleared in
  `finally` so a rejected leader does not poison the key; OTel
  `cache.singleFlight` span with `cache.singleflight.joined` attribute
  marks leader-vs-follower.
- `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
  — added `getOrLoad(payload, loader)` to `IStockCachePort` so use cases
  never see the cache-key + TTL machinery.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
  — implemented `getOrLoad` (cache-aside + re-check inside leader +
  delegated `singleFlight` + write-back with jittered TTL); added private
  `jitterTtl` helper computing ±10% uniform jitter floored to integer ms;
  rewired `set` through the same helper; removed stale CACHE-001 /
  CACHE-004 / CACHE-006 tracking comments (CACHE-006 was already closed
  by ADR-016 per the 2026-05-20 audit, so the comment was stale).
- `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts`
  — replaced the manual `get → repository → set` miss path with a single
  `stockCache.getOrLoad(payload, () => repository.aggregateForProduct(...))`
  call. Skip-cache branches (`entityManager` / `ignoreCache`) untouched.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts`
  — `InMemoryStockCache` now implements the new `getOrLoad` method so it
  still satisfies `IStockCachePort` after the port grew.

## Tests added

- `libs/cache/spec/redis-cache.adapter.spec.ts` — new `singleFlight`
  block covering:
  - 20 concurrent callers on the same key fan out to exactly one `fn`
    invocation; all 20 receive the leader's value.
  - 5 concurrent callers; leader rejects; every waiter sees the same
    rejection (no silent fan-out).
  - In-flight slot cleared after a successful resolution (next call
    invokes a fresh loader — dedupe-while-in-flight, not memoize).
  - In-flight slot cleared after a rejection (retry path starts fresh).
  - Distinct keys remain independent — one key does not block another.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`:
  - `set` test updated to assert TTL inside the `[ttl*0.9-1, ttl*1.1]`
    band (replaces the old exact-60000 assertion; explanatory comment
    cites ADR-021).
  - New `spreads TTLs across many writes` test samples 200 writes and
    asserts min/max bounds, a non-trivial spread, and a mean within 2%
    of the configured TTL.
  - New `getOrLoad` block:
    - Hit returns cached value without invoking the loader or
      `singleFlight`.
    - Miss routes through `cache.singleFlight` under the correct cache
      key; leader writes back with a jittered TTL.
    - Loader rejection propagates without writing to the cache.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/get-stock.use-case.spec.ts`
  — rewritten to target `getOrLoad` (the port surface the use case now
  uses). Headline new test: 15 concurrent `execute` invocations on the
  same miss key collapse to exactly one `repository.aggregateForProduct`
  call when `stockCache.getOrLoad` enforces single-flight semantics.

## ADR created

- `docs/adr/021-cache-single-flight-and-ttl-jitter.md` — Nygard hybrid
  per ADR-003. Decision summary: add `ICachePort.singleFlight(key, fn)`
  (in-process miss-dedupe primitive) and apply ±10% TTL jitter inside
  `StockCache.set`. Documents the in-process-vs-store-side choice (and
  why store-side is overkill at current scale), the jitter range and
  application point, and explicitly asserts ADR-002's cache-aside
  contract is preserved.

## Documentation updates

- `docs/adr/index.md` — added the ADR-021 row.
- `CLAUDE.md` —
  - The `@retail-inventory-system/cache` bullet now lists
    `singleFlight` alongside `delByPrefix` and notes ±10% TTL jitter
    in the stock cache adapter; both link ADR-021.
  - The "Operational notes" cache bullet moves CACHE-001 / CACHE-004
    from "open" to "closed by ADR-021".
- `README.md` —
  - Updated the `cache` library row to include `singleFlight`.
  - TTL section appended with the ±10% jitter contract and a pointer
    to ADR-021.
  - Added a `Miss-path single-flight` subsection.
  - Tracing list updated to include `cache.singleFlight` and the
    `cache.singleflight.joined` attribute.

## Verification results

Commands run from project root:

```
$ yarn install
➤ Done in 2s 593ms

$ yarn build
webpack 5.106.0 compiled successfully in 7076 ms
webpack 5.106.0 compiled successfully in 9193 ms
webpack 5.106.0 compiled successfully in 9439 ms
webpack 5.106.0 compiled successfully in 9208 ms
(all four apps green)

$ yarn lint
EXITCODE=0   # max-warnings 0

$ yarn test:unit
Test Suites: 29 passed, 29 total
Tests:       161 passed, 161 total

$ grep -rE 'cache-manager|@keyv|cacheable' apps/*/src
EXITCODE=1   # zero matches
```

The "worker process has failed to exit gracefully" notice from Jest is
unrelated to this change — it appears across the unmodified test suites
and traces to OTel SDK background timers that the project's Jest config
does not call `.unref()` on. Not a regression introduced here; flagged
below.

## Acceptance-criteria mapping

| Criterion (from the task file)                                          | Where verified                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| ≥10 concurrent miss-path executes → 1 `aggregateForProduct` call         | `get-stock.use-case.spec.ts` "fans out ≥10 concurrent miss-path executes …" (15 callers)                                              |
| Distinct keys remain independent                                         | `redis-cache.adapter.spec.ts` "keeps distinct keys independent — one key does not block another"                                      |
| TTL inside `[ttl*0.9, ttl*1.1]`                                          | `stock.cache.spec.ts` "writes under the new prefix with a jittered TTL …" and "spreads TTLs across many writes …"                     |
| Leader rejection propagates to every waiter (no silent second DB call)   | `redis-cache.adapter.spec.ts` "propagates the same rejection to every waiter"                                                         |
| No new `cache-manager` / `@keyv` / `cacheable` imports in `apps/*/src`   | `grep -rE 'cache-manager\|@keyv\|cacheable' apps/*/src` → no matches                                                                   |
| Existing specs pass unchanged OR updated with explanatory comment        | `get-stock.use-case.spec.ts` and `stock.cache.spec.ts` updated with comments citing ADR-021 on every changed test                     |

## Adjacent findings (surfaced for human review, not fixed in this task)

Per CONVENTIONS §6, these are flagged but not addressed here:

1. **Stale audit-tracking comment in `stock.cache.ts` is now cleaned up
   in this change**, but the same pattern (stale tracking comments
   referring to issues closed by an earlier ADR) likely exists elsewhere
   in the cache and persistence layers. A pass that grep-audits comments
   referencing audit codes against the live audit verdicts would be a
   small, mechanical cleanup.

2. **Single-flight scope is per-process.** ADR-021 documents this
   trade-off explicitly. If the inventory microservice ever scales
   horizontally and `INVENTORY_PRODUCT_STOCK_GET` traffic to one
   `productId` is hot enough that per-replica dedupe is insufficient, a
   store-side advisory lock would be the natural next step. The port
   surface is shaped to support that swap without changing any caller.

3. **Jest "worker failed to exit gracefully" warning.** Pre-existing.
   Surfaces under several spec files; OTel SDK background timers are the
   likely culprit. Worth a separate task to call `.unref()` (or otherwise
   shut down the SDK in `globalTeardown`) so Jest can exit cleanly.

4. **`IStockCachePort.get` / `set` are still part of the public port
   surface after `getOrLoad` absorbed every internal caller.** Today's
   only external consumer of `set` was the use case; `get` is only
   called from inside `StockCache` itself. Could be tightened to a
   `get + getOrLoad + invalidate` port surface in a future cleanup. Not
   done here to avoid scope creep.

5. **`@Cacheable()` decorator still uses `port.wrap` (no single-flight).**
   ADR-021's "Alternatives" §5 records the conscious choice not to
   change `wrap`'s semantics in this task. If a real `@Cacheable`
   consumer lands, promoting `wrap` to single-flighted (or pointing
   consumers at a new `wrapSingleFlight`) becomes the next natural
   refactor.
