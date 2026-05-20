# Carryover — fix-cache-invalidate-contract

> Closes audit item **CACHE-002** ("post-commit invalidate contract is
> comment-enforced"). See
> [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md).

## Design chosen

**Option A — `withInvalidation` wrapper on the cache port.** Detailed
rationale and alternatives considered live in
[`docs/adr/023-cache-invalidate-post-commit-by-type.md`](../adr/023-cache-invalidate-post-commit-by-type.md).

Headline shape:

```ts
interface IStockCachePort {
  // ...
  withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T>;
}
```

`IStockCachePort.invalidate(...)` is **removed from the public port
surface**. The prefix-delete fan-out (ADR-022 v1 + pre-v1 +
pre-ADR-016 wipes) lives on `StockCache` as a private
`invalidatePrefixes(items, opts)` method, reachable only from inside
`withInvalidation`. The post-commit ordering is encoded in the
helper's body (`await work(); ...await invalidatePrefixes(...)`).

Why Option A over Option B (an `afterCommit` registry on
`IStockRepositoryPort`):

- keeps the transactional concern out of `libs/cache` and off the
  generic repository surface,
- composes cleanly with the future `ITransactionPort` (ARCH-LINT-EX-01
  in ADR-017 §6) — the helper takes a `work: () => Promise<T>`
  callback that knows nothing about TypeORM, so swapping the
  `entityManager.transaction(...)` seam for `transactionPort.run(...)`
  later is a body-only change at the call site,
- the type signature carries the discovery → invalidate ordering
  (`resolveItems` reads the resolved `work` result, so a misuse cannot
  be expressed).

## Files edited

- `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
  — removed public `invalidate(...)` and `IStockCacheInvalidatePayload`;
  added `withInvalidation(work, resolveItems, opts?)` and
  `IStockWithInvalidationOptions`. Updated the port's docstring to call
  out ADR-023.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
  — replaced public `invalidate(...)` with public
  `withInvalidation(...)` and a private `invalidatePrefixes(items,
  opts?)` that owns the ADR-022 fan-out unchanged.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`
  — wrapped the `entityManager.transaction(...)` call in
  `stockCache.withInvalidation(work, resolveItems, { correlationId })`.
  Deleted the 13-line post-commit-ordering comment block at the
  previous L122–L132 — the rule is now encoded in the helper. Preserved
  the `CODE-001` comment block about the unreachable `!!item.storageId`
  filter (now sitting inside `resolveItems`).
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts`
  — `InMemoryStockCache` now implements `withInvalidation` (work then
  record items). Removed the orphan `invalidate(...)` method.

## Tests added/updated

- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/reserve-stock-for-order.use-case.spec.ts`
  — replaced the `invalidate` mock surface with a faithful
  `withInvalidation` stand-in that records ordering + items. Updated
  every existing assertion to the new shape. The pre-existing test
  *"error-logs and rethrows when the transaction rejects, and does
  not invalidate"* continues to pass under the new code path. Added
  *"does not invoke invalidatePrefixes when work rejects after partial
  appendDeltas"* — locks in the harder rejection scenario where the
  inner work has done side-effecting I/O before the commit fails.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`
  — replaced `describe('invalidate')` with
  `describe('withInvalidation')`, same coverage plus three new ordering
  tests: *runs the prefix delete after work resolves*, *does not invoke
  the prefix delete when work rejects*, *skips the prefix delete when
  resolveItems returns []*.

Coverage is strictly broader than before — the contract is now tested
at the adapter level (ordering + rejection skip) **and** at the
use-case level (positive + rejection paths through the production
helper's body).

## ADR created

- [`docs/adr/023-cache-invalidate-post-commit-by-type.md`](../adr/023-cache-invalidate-post-commit-by-type.md)
  — *Post-commit cache invalidation enforced by the type system.*
  Status `Accepted`. Records the chosen Option A, the rejected Option
  B (`afterCommit` registry), and two further rejected alternatives
  (runtime guard inside `invalidate`, `@internal` JSDoc tag). Notes
  that the ADR-002 cache-aside contract is preserved verbatim and
  that the helper composes cleanly with the future `ITransactionPort`.

## Documentation updates

- `docs/adr/index.md` — appended row 023.
- `CLAUDE.md` —
  - "Service Structure → Microservices → stock" table now mentions
    that write-path invalidation is reachable only through
    `withInvalidation(work, resolveItems, opts)` per ADR-023.
  - "Cache-key convention" paragraph now records that
    `IStockCachePort` has no public `invalidate` and that callers route
    writes through `stockCache.withInvalidation(...)` (ADR-023). The
    existing ADR-022 transition-window detail (three prefixes per
    productId) is preserved as a description of the helper's internal
    fan-out.
  - "Operational notes → Redis cache-aside" line now lists CACHE-002 as
    closed by ADR-023; CACHE-005 remains as the only open item from
    the original audit.
- No `README.md` update required — `IStockCachePort` and `StockCache`
  are internal contracts that no external consumer references.

## Verification results

All run from a clean tree at HEAD (branch
`RIS-40-Architecture-migration-Final-audit`):

| Check                              | Result                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| `yarn install --immutable`         | ✅ Done in 3s 156ms                                                    |
| `yarn build`                       | ✅ webpack 5 compiled successfully for all four apps                  |
| `yarn lint`                        | ✅ exit 0, 0 errors / 0 warnings (max-warnings 0)                     |
| `yarn test:unit`                   | ✅ 29 suites / 171 tests passed                                       |
| existing "tx rejects → no invalidate" test | ✅ still passes under the new helper-driven code path           |
| new positive-path "appendDeltas before invalidatePrefixes" test | ✅ passes                                  |
| new adapter-level "work → resolveItems → delByPrefix" test     | ✅ passes                                  |

E2E was not run (per CONVENTIONS.md §4 it is opt-in and this fix
touches no cross-service code path — the helper sits entirely inside
the inventory microservice).

## Anything unexpected

- **Lint-fix loop on `async () => undefined` in the new adapter
  spec.** ESLint's `@typescript-eslint/require-await` rejects an
  `async` arrow with no `await`. The fix is mechanical (rewrite as
  `() => Promise.resolve()`), but five test cases needed it, and one
  needed a similar rewrite of a `jest.fn(async () => { ... })`
  closure. No semantic change.
- **Stale `InMemoryStockCache` test double in
  `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts`.**
  The file is not imported by any current spec (only the API
  gateway / retail / notification microservices use sibling
  `test-doubles.ts` files). It still has to be kept in sync with the
  port shape because `**/*.spec.ts` is the only exclude on the
  inventory `tsconfig.app.json`, so `test-doubles.ts` is type-checked
  at build time. Updated alongside the port; flagged here for
  follow-up cleanup (either delete the orphan or actually use it).
- **`CACHE-006` annotation comment in `stock.cache.ts` is still
  stale**, as documented in the 2026-05-20 follow-up audit's
  "Verification of issues annotated as resolved by the migration"
  section (it lists CACHE-006 as resolved while the in-code comment
  still calls it open). Out of scope for this fix per
  CONVENTIONS.md §6 (avoid scope creep); recording here as a
  follow-up candidate.
