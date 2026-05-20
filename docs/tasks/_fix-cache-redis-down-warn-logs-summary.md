# fix — single warn log on Redis-down — carryover

Closes audit item **CACHE-005** (duplicate warn logs on Redis-down) per
[`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md).

## Return-shape choice

Took the task's first option: changed `IStockCachePort.get` from
`Promise<ProductStockGetResponseDto | undefined>` to
`Promise<IStockCacheGetResult>` where

```ts
interface IStockCacheGetResult {
  value: ProductStockGetResponseDto | undefined;
  available: boolean;
}
```

The `available` flag distinguishes a clean miss
(`{ value: undefined, available: true }`) from a Redis-down outage
(`{ value: undefined, available: false }`). Rejected the alternative
of a parallel `cacheAvailable()` adapter-state flag because it would
have introduced shared mutable state with TTL/reset semantics — heavier
than the per-call signal the call sites actually want. `libs/common`'s
`Result<T,E>` would have worked but two boolean states didn't justify
the type-import; the inline interface is lighter.

## Scope adjustment vs. task text

The task as written assumes `GetStockUseCase.execute` calls
`stockCache.get` and `stockCache.set` directly (the pre-ADR-021 shape),
and prescribes the fix at that layer. The current code routes all
cache-aside through `StockCache.getOrLoad` (introduced for ADR-021
single-flight + jitter), so under the old code the outage warn count
was actually **3** per request (outer `get`, inner `get` inside the
single-flight leader, then `set`), not 2.

I applied the task's intent ("one warn per request, DB fallback
intact") inside `getOrLoad`:

- Outer `get` runs first as before. On an outage it warn-logs once and
  returns `{ value: undefined, available: false }`.
- `getOrLoad` short-circuits when `available === false`: it skips the
  single-flight join and the write-back, and falls through to a direct
  `loader()` call so the DB fallback still serves the request.
- On a clean miss (`available: true`) the existing single-flight +
  set-back path runs unchanged.
- A defensive inner guard inside the leader skips `set` if the inner
  `get` re-check observes a fresh outage that the outer read didn't.

Where the task says "update the use-case spec to mock the new shape
and add three outage tests there," the corresponding behaviour now
lives in `StockCache.getOrLoad`, so the three outage tests landed in
`stock.cache.spec.ts` (where warn counts are directly observable via
the PinoLogger mock). `get-stock.use-case.spec.ts` only mocks
`getOrLoad`, so it needed no return-shape change.

## Files edited

- `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
  — added `IStockCacheGetResult`; changed `IStockCachePort.get` return type.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
  — `get` returns the new shape; `getOrLoad` short-circuits on
  `available: false`; closed-audit comment block updated (removed
  CACHE-005 from "open" list, added the closure note).
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts`
  — `InMemoryStockCache.get` returns the new shape; `getOrLoad`
  respects `available`.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`
  — `get` block updated to the new shape; three outage tests added
  under `getOrLoad`.
- `CLAUDE.md` — moved CACHE-005 from "open audit items" to the closed
  list, with a one-line explanation of the closing mechanism.

## Tests added

Under `describe('getOrLoad')` in `stock.cache.spec.ts`:

1. **complete outage** — `cache.get` and `cache.set` both reject;
   asserts exactly one `logger.warn` call (the read failure), `cache.set`
   never invoked, `cache.singleFlight` never invoked, loader result
   returned to caller.
2. **read-only outage** — `cache.get` rejects, `cache.set` would
   succeed; asserts that `set` is still not called (the `available`
   flag governs the skip, not the actual set behaviour). One warn line.
3. **write-only outage** — `cache.get` resolves to `undefined` cleanly,
   `cache.set` rejects; asserts one warn line (the write failure), the
   DB result is still returned to the caller, `set` was attempted once.

Each test asserts `logger.warn` call count explicitly (`toHaveBeenCalledTimes(1)`),
so a future regression that re-introduces a duplicate warn fails the
spec.

## Documentation updates

- **ADR**: none required. The change is a small contract refinement
  (one new field in the `get` return value); not a new architectural
  pattern. Cross-checked against the convention in
  [`docs/tasks/CONVENTIONS.md`](CONVENTIONS.md) §5.
- **`CLAUDE.md`**: updated to mark CACHE-005 closed and record the
  mechanism (single-line edit to the audit-status sentence under
  "Operational notes").
- **`README.md`**: no update required — the externally observable
  behaviour is unchanged (warn count is internal observability, not a
  contract surface for consumers of the service).

## Verification

- `yarn install` — clean.
- `yarn build` — all four apps compiled successfully via webpack 5.
- `yarn lint` — clean with `--max-warnings 0`.
- `yarn test:unit` — **29 suites / 174 tests pass**, including the
  three new outage tests, the updated `get` block, and the
  `architecture-lint.spec.ts` boundary regression suite.

## Anything unexpected

- The task description references an older code shape that pre-dates
  ADR-021. Recorded above under "Scope adjustment vs. task text".
- A pre-existing Jest warning ("A worker process has failed to exit
  gracefully") appeared on the final summary line. It is unrelated to
  this change — likely a TypeORM / Redis client cleanup quirk in
  Jest's worker — and the full suite still passes. Not in scope for
  this fix.
- `docs/audits/audit-2026-05-20-followup.md` is a historical audit
  artifact, not a living index; it was not updated. The canonical
  open/closed status now lives in `CLAUDE.md` and in the closure
  comment at the top of `stock.cache.ts`.
