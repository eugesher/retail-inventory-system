# task-11 — Generalize cache-aside on read paths and invalidation on writes (Phase 7, cache)

> Re-scoped per `_carryover-01.md`: ADR-002 already covers
> cache-aside for product stock, and task-08 relocated the
> `ProductStockCommonCache` machinery into
> `apps/inventory-microservice/src/modules/stock/infrastructure/cache/`.
> This task **generalizes** the pattern to remaining read paths
> (orders, future product list, etc.) and addresses the open audit
> findings in `docs/audits/audit-2026-05-08.md` (CACHE-001 stampede
> protection, CACHE-003 schema-version segment, CACHE-009 tenant
> prefix, CACHE-010 sort-comparator bug, CACHE-011 literal-`*`
> sentinel) where they intersect generalization. Items already
> covered by ADR-002 stay covered.

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-10.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: every service is hexagonal,
  observability is wired. `@retail-inventory-system/cache` exposes
  `CachePort`, `RedisCacheAdapter`, and `@Cacheable` (added in
  task-04). ADR-002 captures cache-aside for product stock and that
  semantics has been preserved through the inventory reshape in
  task-08. This task generalizes that pattern to remaining read paths
  and adds explicit invalidation on the corresponding write paths.

## Prerequisites

- [ ] `_carryover-10.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] `libs/cache/src/cache.port.ts`, `redis-cache.adapter.ts`,
  `decorators/cacheable.decorator.ts`, `cache-keys.ts` exist
  (created in task-04). The `ProductStockCommonCache` semantics
  from ADR-002 have been preserved in
  `apps/inventory-microservice/src/modules/stock/infrastructure/cache/`
  per task-08.

## Goal

Apply `@Cacheable` to every read use case where it makes sense
(`GetStockUseCase` retains the existing semantics; `GetOrderUseCase`
gains caching if profitable — measure first), and add explicit
invalidation in the corresponding write use cases
(`ReserveStockForOrderUseCase`, `ConfirmOrderUseCase`,
`AddStockUseCase`, etc.). Every cache key follows the
`ris:<service>:<aggregate>:<id>` convention (the existing
`stock:<productId>:...` keys remain valid for in-flight entries
during the deploy; new code uses the new prefix). Cache keys live
in `libs/cache/src/cache-keys.ts`. Every write path either invalidates
specific keys or invalidates a tag/prefix.

## Steps

1. **Inventory read use cases.** For each microservice, list every
   `application/use-cases/get-*.use-case.ts` and
   `list-*.use-case.ts`. Decide which are cache-friendly (idempotent,
   high read frequency, tolerable staleness). Record the decision
   per use case.

2. **Centralize cache keys.** In `libs/cache/src/cache-keys.ts`,
   add a typed builder per aggregate:
   ```ts
   export const CACHE_KEYS = {
     retailOrder: (id: number) => `ris:retail:order:${id}`,
     // legacy shape (kept stable through the deploy):
     inventoryStockLegacy: (productId: number, storageIds?: string[]) =>
       /* mirrors the existing CacheHelper.keys.productStock */ ...,
     // new shape:
     inventoryStock: (productId: number, storageIds?: string[]) =>
       `ris:inventory:stock:${productId}:${[...(storageIds ?? [])].sort((a, b) => a.localeCompare(b)).join(',') || '__all__'}`,
   } as const;
   ```
   No string literals at call sites. The new `inventoryStock`
   builder fixes audit findings CACHE-010 (full lexicographic
   compare via `localeCompare`) and CACHE-011 (non-glob
   `__all__` sentinel) at the same time. Document the dual-format
   transition in `_carryover-11.md`.

3. **Decorate the read use cases.** Add `@Cacheable({ key, ttl })`
   to the chosen `execute()` methods. TTLs:
   - per-id reads: 60s default,
   - list reads: 30s default,
   - aggregates known to change rarely: 5min.
   Each TTL choice goes in the carryover with a one-line rationale.

4. **Invalidation on writes.** For each write use case, add explicit
   `cache.del(CACHE_KEYS.foo(id))` calls **after** the persistence
   commit succeeds. Where a write affects a list view, also delete
   the list key (or use a coarse prefix delete via the Redis adapter
   if the existing adapter exposes one — verify).

5. **Wire `CacheModule` into every feature module** that uses
   `@Cacheable` and ensure the DI container provides the
   `CACHE_PORT` symbol. The decorator must lazily resolve via the
   ApplicationContext. Task-04 introduced the decorator skeleton;
   verify lazy DI resolution works against the
   `ApplicationContextHost` exposed by Nest 11 (`@Inject('REQUEST',
   { lazy: true })` may be needed depending on scope). Fix any
   gap surfaced here rather than papering over it with eager DI.

6. **Tests.**
   - Unit test per cached use case: first call hits the repository,
     second call (within TTL) does not.
   - Unit test per write use case: after `execute()`, the
     corresponding `del(...)` was called with the expected keys.
   - Integration test against a real Redis (the existing
     `test:infra:up` already provisions Redis) that asserts a
     read-through followed by an invalidation re-populates the cache
     on the next read.

7. **Trace cache hits and misses.** If task-10's OTel work is in
   place, the decorator should open a span (`cache.get`,
   `cache.set`, `cache.del`) and add `cache.hit=true|false` as a
   span attribute. This is optional but cheap and makes performance
   regressions visible in Jaeger.

## Documentation updates required

- [ ] `README.md`: new "Caching" sub-section under Architecture
  describing: the `@Cacheable` decorator, the key convention, the
  invalidation strategy, and how to disable cache locally
  (`CACHE_DISABLE=1` if implemented).
- [ ] `CLAUDE.md`: add the cache-key-naming rule
  (`ris:<service>:<aggregate>:<id>`) and the rule that read paths
  invalidate via the central `CACHE_KEYS` registry only.
- [ ] `docs/adr/NNN-cache-aside-generalized.md` (or update the
  existing ADR-002): records the generalization to all read paths
  and the invalidation policy.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds — including the new cache hit/miss
  and invalidation tests.
- [ ] `yarn test:e2e` succeeds.
- [ ] `grep -rE 'redis|cache-manager|keyv' apps/*/src` returns
  **zero** results (every cache call goes through `libs/cache`).
- [ ] No string literal cache key under `apps/*/src` — every cache
  call references `CACHE_KEYS.*`.

## Carryover

Write `_carryover-11.md` with:
- Read use cases decorated (with TTLs and rationale).
- Write use cases that gained invalidation (with key sets).
- Tests added.
- Verification results.
- Cache trace screenshots / span dumps if task-10's tracing is in
  place.
- Audit findings closed by this task (e.g. CACHE-010 sort fix,
  CACHE-011 sentinel rename) and findings still open. Update
  `docs/audits/audit-2026-05-08.md` accordingly — set Status to
  resolved with a back-reference to this task.
- Suggested adjustments to task-12 (the `boundaries` rules will
  need to permit `@retail-inventory-system/cache` from
  `infrastructure/cache/`).
