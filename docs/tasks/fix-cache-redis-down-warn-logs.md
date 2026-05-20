# fix — single warn log on Redis-down

> Paste this entire file as the first user message in a Claude Code (Opus)
> session opened at the project root of `retail-inventory-system`. Do not
> add anything else.

## Conventions

This task inherits the rules in
[`docs/tasks/CONVENTIONS.md`](CONVENTIONS.md). Read it before starting.

## Context

- Source audit: [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md)
- Issue addressed: **CACHE-005**
- Original audit (historical): [`docs/audits/audit-2026-05-08.md`](../audits/audit-2026-05-08.md)
- Relevant ADR: [ADR-002](../adr/002-redis-cache-aside-product-stock.md) (graceful-degradation section)

`StockCache.get` and `StockCache.set` each wrap their Redis call in an
independent `try/catch` and warn-log on failure. During a Redis outage,
a single `GetStockUseCase.execute` miss produces **two** warn lines per
request:

1. `StockCache.get` catches the Redis error, returns `undefined` →
   logs `"Failed to read from cache"`.
2. `GetStockUseCase.execute` interprets `undefined` as a miss, runs
   the DB aggregation, calls `StockCache.set(...)` which also catches
   the Redis error → logs `"Failed to write to cache"`.

The functional behavior is correct (the DB fallback works), but the
duplicate log lines pollute the warn channel during incidents and make
"how many cache outages happened today" hard to count.

Why it matters: outage observability matters as much as outage
correctness. Operators tuning alerts on `Failed to read from cache`
will get inflated counts; suppressing the second warn keeps the signal
clean.

## Goal

A single `GetStockUseCase.execute` during a complete Redis outage
produces **one** warn log line. The DB fallback continues to work
exactly as today. A partial outage (read succeeds, write fails — rare
but possible during failover) still warn-logs the write failure.

## Acceptance criteria

- [ ] A unit test simulating a complete Redis outage (both `get` and
      `set` reject with the same error) verifies that exactly **one**
      warn log line is emitted per `GetStockUseCase.execute` call.
- [ ] A unit test simulating a read-only outage (get rejects, set
      succeeds) verifies that one warn line is emitted (the read failure)
      and `set` is *not* attempted.
- [ ] A unit test simulating a write-only outage (get returns
      `undefined` cleanly, set rejects) continues to emit one warn line
      (the write failure) and the DB result is still returned to the
      caller.
- [ ] The functional behavior on outage is unchanged: `GetStockUseCase.execute`
      returns the DB result, never throws on cache failure.
- [ ] The cache hit path is unchanged — no extra checks on the happy
      path.

## Files likely involved

- `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
  — extend the `get` return type to carry a `cacheAvailable` flag, or
  add a separate method, or pass through a `Result<DTO|undefined, error>`.
  Choose the simplest shape that lets `GetStockUseCase` decide whether
  to attempt `set`.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
  — emit the flag from `get`. Skip `set` when called with `cacheAvailable=false`
  if you go the parameter route.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts`
  — gate the `stockCache.set` call on the flag.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/get-stock.use-case.spec.ts`

## Steps

1. Pick a shape. Simplest: change `IStockCachePort.get` to return
   `{ value: DTO | undefined; available: boolean }` instead of
   `DTO | undefined`. The use case observes `available === false` and
   skips the `set` call.

   Alternative: keep `get` returning `DTO | undefined` and add a
   parallel `cacheAvailable(): boolean` flag that the adapter flips
   on error and resets after a TTL or on the next successful op. Adds
   shared state — likely overkill.

   Use [`libs/common`](../../libs/common) types if `Result<T, E>` fits
   — it exists in the lib. But a tiny `{ value, available }` interface
   is fine too and lighter.

2. Implement the change in `StockCache.get`: in the `catch` branch
   return `{ value: undefined, available: false }`. In the success
   branch return `{ value: cached, available: true }`. Cache miss is
   `{ value: undefined, available: true }`.

3. Update `GetStockUseCase.execute` to read the new shape:
   ```ts
   const { value, available } = await this.stockCache.get({ ... });
   if (value !== undefined) return value;
   const data = await this.repository.aggregateForProduct({ ... });
   if (available) {
     await this.stockCache.set({ productId, storageIds, data, correlationId });
   }
   return data;
   ```
   Keep the `// AUDIT-2026-05-08 [CACHE-001]` race-window comment block
   intact — that's tracked under a different fix task.

4. Update specs:
   - `stock.cache.spec.ts` `get` block: adjust hit/miss/error tests to
     the new return shape. The "returns undefined and warn-logs when
     cache.get rejects" test now becomes "returns `{ value: undefined,
     available: false }` and warn-logs when cache.get rejects".
   - `get-stock.use-case.spec.ts`: the existing hit/miss tests update
     their mocks to return the new shape. Add three new tests:
     - **complete outage** (`get` returns `{value:undefined, available:false}`,
       repository succeeds, `set` is **not called**, exactly one warn
       line from `StockCache.get`).
     - **read-only outage** (same as complete outage but `set` would
       have succeeded — verifies the `available` flag governs the
       skip, not actual set behavior).
     - **write-only outage** (`get` returns `{value:undefined,
       available:true}`, repository succeeds, `set` is called and
       rejects, exactly one warn line from `StockCache.set`).

5. Run the verification gate.

## Documentation updates required

- [ ] No ADR required. This is a small contract refinement, not a new
      architectural pattern. The decision is "the cache port now
      signals availability separately from value" — too local for an
      ADR.
- [ ] Update `CLAUDE.md` if the `IStockCachePort.get` return-type bullet
      under "Service Structure" mentions the old shape — quick grep
      confirms whether an update is needed.
- [ ] No `README.md` update required. Record explicitly in the carryover.

## Verification

- [ ] `yarn install` succeeds
- [ ] `yarn build` succeeds
- [ ] `yarn lint` succeeds (max-warnings 0)
- [ ] `yarn test:unit` succeeds
- [ ] The three new outage tests pass; together they assert the warn
      count is exactly 1 per request under each outage shape

## Carryover

Write `_fix-cache-redis-down-warn-logs-summary.md` with:

- Return-shape choice (`{value, available}` vs alternative)
- Files edited
- Tests added (the three outage tests)
- Documentation updates (or "none required" with reason)
- Verification results
- Anything unexpected — surface for human review
