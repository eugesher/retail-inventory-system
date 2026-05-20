# fix — cache stampede protection and TTL jitter

> Paste this entire file as the first user message in a Claude Code (Opus)
> session opened at the project root of `retail-inventory-system`. Do not
> add anything else.

## Conventions

This task inherits the rules in
[`docs/tasks/CONVENTIONS.md`](CONVENTIONS.md). Read it before starting —
in particular: no git mutations, no eslint-rule weakening, mandatory
verification gate, and the documentation discipline.

## Context

- Source audit: [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md)
- Issues addressed: **CACHE-001**, **CACHE-004**
- Original audit (historical): [`docs/audits/audit-2026-05-08.md`](../audits/audit-2026-05-08.md)
- Relevant ADRs: [ADR-002](../adr/002-redis-cache-aside-product-stock.md),
  [ADR-006](../adr/006-cache-aside-via-libs-cache.md),
  [ADR-016](../adr/016-cache-aside-generalized.md)

Two coupled architectural gaps in the stock cache-aside path:

**CACHE-001 — read/write race on cache miss.** In
`apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts`
the miss path (L64–L74) runs `repository.aggregateForProduct` and then
`stockCache.set` with no single-flight or version-stamp protection. A
concurrent confirm can commit + SCAN-invalidate in the window between
the reader's DB read and the reader's `cache.set`, leaving the now-stale
DB result in the cache for one TTL. The same window also fans out N
parallel DB queries when N readers miss the same key simultaneously
("cache stampede"). The original audit framed these as one issue
because the same protection mechanism (`p-limit` per key, `redis-stampede`,
or a store-side advisory lock) addresses both.

**CACHE-004 — no TTL jitter.** In
`apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
the `set` method (L61–L75) passes the raw configured TTL straight to
`ICachePort.set`. Any batch of writes that lands within one event-loop
tick expires together — risk of a thundering herd at the TTL boundary if
traffic is correlated.

Why they matter: both increase load on MySQL precisely when the system
is already busy (correlated misses, expiry stampedes). CACHE-001 also
widens the bounded-staleness window the cache-aside contract relies on.

## Goal

Stock-cache misses are bounded to a single in-flight DB query per cache
key (single-flight on miss), and TTLs carry ±10% jitter so writes
batched within one tick do not expire together. The protection lives
behind the existing `ICachePort` / `IStockCachePort` boundary so domain
code is unaffected. ADR-002's correctness contract is preserved.

## Acceptance criteria

- [ ] Concurrent misses on the same `(productId, storageIds)` cache key
      fan out to exactly **one** `repository.aggregateForProduct` call.
      Verified by a unit test that simulates ≥10 concurrent
      `GetStockUseCase.execute` invocations on a single miss key and
      asserts the repository was called exactly once.
- [ ] Distinct cache keys remain independent — concurrent misses on
      different keys do not block each other. Verified by a unit test.
- [ ] `stockCache.set` writes carry a TTL within `[ttl * 0.9, ttl * 1.1]`
      (inclusive). Verified by a unit test that captures the TTL argument
      across many writes and asserts the spread.
- [ ] When the single-flight leader's DB query rejects, every waiter
      receives the same rejection (does not silently fall through to a
      second DB call). Verified by a unit test.
- [ ] No new direct import of `@nestjs/cache-manager`, `@keyv/redis`, or
      `cacheable` lands in `apps/*/src` — `grep -rE 'cache-manager|@keyv|cacheable' apps/*/src` returns zero matches after the change.
- [ ] The existing `stock.cache.spec.ts` and `get-stock.use-case.spec.ts`
      pass without alteration, OR are updated to reflect the new
      contract with an explanatory comment on each change.

## Files likely involved

- `libs/cache/cache.port.ts` — possibly extend `ICachePort` with a
  `singleFlightWrap` primitive, or alternatively wrap `wrap` to provide
  the guarantee. Either choice is acceptable; document the chosen
  direction in the ADR (see Documentation updates below).
- `libs/cache/redis-cache.adapter.ts` — implementation of the new
  primitive on the Redis-backed adapter. The simplest choice is an
  in-process `Map<string, Promise<T>>` of in-flight loads keyed by the
  cache key; a store-side advisory lock is an option but adds
  network round-trips and is overkill for a single-replica setup.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
  — apply jitter inside `set` (`ttl + Math.floor((Math.random() * 0.2 - 0.1) * ttl)`
  is one form; document any deterministic alternative).
- `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts`
  — if the chosen design exposes `singleFlightWrap` on `IStockCachePort`,
  rewire the miss path through it; alternatively keep the use case
  unchanged and let the wrapping happen inside `StockCache.get`.
- `libs/cache/spec/redis-cache.adapter.spec.ts`,
  `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`,
  `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/get-stock.use-case.spec.ts`
  — concurrency and jitter assertions.

(These are starting points, not a contract. The executing session
verifies and extends.)

## Steps

1. Read the three ADRs above to confirm the contract you must preserve
   (cache-aside read-on-miss; post-commit invalidate; graceful Redis-down
   fallback). The TTL safety net is a *correctness* mechanism for the
   invalidate-on-outage case; jitter must not break it (i.e. don't set
   TTL=0 ever; the floor of the jittered TTL must remain ≥ `ttl * 0.9`).
2. Decide where the single-flight primitive lives — on `ICachePort`
   (and therefore inherited by every aggregate cache in `libs/cache`) or
   on `IStockCachePort` (stock-only). Strong preference for the port
   level: ADR-016 generalized cache-aside, and other aggregates
   (`retail.order:7` builders already exist in `cache-keys.ts`) will
   want the same protection. Document the choice in an ADR.
3. Implement the primitive against the in-process `Map<string,
   Promise<T>>` pattern. Clear the entry in a `finally` block so a
   rejected leader does not poison the key permanently. Make every
   waiter observe the same resolution (success or rejection) as the
   leader.
4. Apply ±10% TTL jitter inside `StockCache.set` (or inside
   `RedisCacheAdapter.set` if the choice is to make jitter universal —
   discuss in the ADR). Use `Math.random()`; deterministic jitter
   keyed on the cache key is an alternative if a test-flake concern
   surfaces, but adds complexity.
5. Update specs to cover the new contract:
   - `redis-cache.adapter.spec.ts` (or wherever the primitive lives):
     concurrent calls collapse to one loader; rejection propagation;
     no leak after success/rejection.
   - `stock.cache.spec.ts`: TTL spread assertion over many writes.
   - `get-stock.use-case.spec.ts`: ≥10 concurrent `execute` calls on
     the same miss key result in exactly one `repository.aggregateForProduct`
     call.
6. Run the verification gate (see CONVENTIONS §4). Resolve any lint
   failures by fixing imports, not by relaxing boundaries.

## Documentation updates required

- [ ] **ADR required.** Create `docs/adr/<NNNN>-<slug>.md` (next free
      number lives in `docs/adr/index.md`; the index file's last row
      tells you the next sequential number) documenting:
      - which port the single-flight primitive lives on,
      - the in-process vs store-side choice and why,
      - the jitter range and where it's applied,
      - explicitly that ADR-002's contract is preserved.
      Format: Nygard hybrid per ADR-003.
- [ ] Update `docs/adr/index.md` with the new ADR entry.
- [ ] If `ICachePort` grew a new method, update the bullet list in
      `CLAUDE.md` under "Shared Libraries → `@retail-inventory-system/cache`"
      to mention it.
- [ ] If the TTL jitter changes externally observable behavior (it
      does — entries no longer expire on exact boundaries), add a short
      note under the cache section of `README.md` if that section
      enumerates TTL behavior; otherwise skip and record "no README
      update required" with the reason in the carryover.

## Verification

- [ ] `yarn install` succeeds
- [ ] `yarn build` succeeds (all four apps)
- [ ] `yarn lint` succeeds (max-warnings 0)
- [ ] `yarn test:unit` succeeds
- [ ] The five new spec assertions listed under Acceptance criteria
      all pass
- [ ] `grep -rE 'cache-manager|@keyv|cacheable' apps/*/src` returns
      zero matches

## Carryover

At completion, write `_fix-cache-stampede-and-jitter-summary.md` next to
this file with:

- Files edited (paths + one-line summary of the change)
- Tests added (paths + what each asserts)
- ADR created (path + one-line decision summary)
- Documentation updates (or "none required" with reason)
- Verification results (raw command output, or pointers to the relevant
  output lines)
- Anything unexpected the session noticed adjacent to the work — surface
  for human review, do not fix in this task (per CONVENTIONS §6)
