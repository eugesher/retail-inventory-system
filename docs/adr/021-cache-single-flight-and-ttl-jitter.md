# ADR-021: In-process single-flight and ±10% TTL jitter on the cache port

- **Date**: 2026-05-20
- **Status**: Accepted

---

## Context

[ADR-002](002-redis-cache-aside-product-stock.md) introduced the cache-aside
contract for product-stock queries; [ADR-006](006-cache-aside-via-libs-cache.md)
moved it behind the generic `ICachePort` in `libs/cache`; and
[ADR-016](016-cache-aside-generalized.md) generalized the key convention and
added the `delByPrefix` invalidation primitive. ADR-016 §"Still open"
explicitly carried over two architectural issues:

- **CACHE-001** — the miss-path in
  `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts`
  ran `repository.aggregateForProduct` and then `stockCache.set` with no
  protection. Concurrent misses on the same key fanned out N parallel DB
  queries ("cache stampede"); a concurrent commit + SCAN-invalidate landing
  between the reader's DB read and the reader's `cache.set` would leave a
  stale value in the cache for one TTL.

- **CACHE-004** — `StockCache.set` passed the raw configured TTL straight
  to `ICachePort.set`. A batch of writes landing within one event-loop tick
  expired together, producing a thundering herd at the TTL boundary if
  traffic was correlated.

Both increase DB load precisely when the system is already busy (correlated
misses, expiry stampedes). CACHE-001 also widens the bounded-staleness
window that ADR-002's contract relies on.

The post-2026-05-08 follow-up audit
([`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md))
re-confirms both findings against the post-migration code at their new line
ranges and bundles them into one fix because the same protection mechanism
addresses both.

## Decision

Two coupled primitives land in `libs/cache` and one aggregate-level wrapper
lands in the inventory stock cache:

### 1. `ICachePort.singleFlight(key, fn)` — in-process dedupe primitive

A new method on the generic cache port:

```ts
singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T>
```

Semantics:

- Concurrent calls with the same `key` invoke `fn` exactly once. The first
  caller is the leader; subsequent callers attach to the leader's pending
  promise.
- Every waiter observes the same outcome — value or rejection. A rejected
  loader does not silently fan out to a second invocation; every waiter
  sees the same error.
- The in-flight entry is cleared in `finally`, so a rejected leader does
  not poison the key — the next call after settlement starts a fresh
  loader.
- Scope is the current Node process. Two replicas miss the same key
  twice; one replica's stampede no longer fans out to `concurrency ×
  loader-cost`. See "Alternatives" for the store-side-lock rejection.

Implementation in `RedisCacheAdapter`: a `private readonly inFlight = new
Map<string, Promise<unknown>>()`. The leader stores its promise in the
map and clears the slot via `.finally(() => this.inFlight.delete(key))`;
followers return the existing promise.

### 2. ±10% TTL jitter inside `StockCache.set`

The write path computes `Math.floor(ttl + (Math.random() * 2 - 1) * 0.1 *
ttl)` and passes the result to `ICachePort.set`. The band is
`[ttl * 0.9 (floored), ttl * 1.1)`. The floor preserves ADR-002's TTL
safety-net role — a missed invalidate still produces a *bounded*
staleness window. The TTL never hits zero.

Jitter is applied at the aggregate level (`StockCache`), not in
`RedisCacheAdapter`. The generic adapter remains a faithful pass-through:
the TTL it receives is the TTL it persists. Aggregates that want jitter
opt in by computing it in their own `set` method; future aggregates can
make a different policy choice (none, ±5%, deterministic) without
touching the port contract.

### 3. `IStockCachePort.getOrLoad(payload, loader)` — domain wrapper

The use case (`GetStockUseCase.execute`) no longer composes `get → loader
→ set` directly. It calls:

```ts
return this.stockCache.getOrLoad(
  { productId, storageIds, correlationId },
  () => this.repository.aggregateForProduct({ productId, storageIds, correlationId }),
);
```

`StockCache.getOrLoad` does the cache-aside read first (graceful: a cache
read error is treated as a miss per the existing `get` contract). On a
miss it delegates the loader-and-write to `cache.singleFlight(key, ...)`,
which re-checks inside the leader to catch the (rare) race where a hit
landed between the outer read and the leader start.

The skip-cache branches (`entityManager` or `ignoreCache: true`) remain
in the use case — they short-circuit before `getOrLoad` is reached.

### 4. ADR-002 contract preservation

The new primitives strictly tighten the cache-aside contract. They do not
relax it:

- Cache-aside read-through, DB-on-miss, write-back — unchanged.
- Post-commit invalidation via `delByPrefix` — unchanged.
- TTL as a safety net — unchanged; the jitter floor preserves it.
- Graceful degradation on Redis failure — preserved: `StockCache.get`
  still swallows read errors, `set` still warn-logs and swallows write
  errors, and `singleFlight` does not introduce a new cache call.

## Alternatives Considered

1. **Store-side advisory lock (`SET key NX EX`).** Rejected. A
   network-bound mutex would dedupe across replicas, at the cost of two
   extra Redis round-trips per miss (acquire + release) and a lease-TTL
   parameter to tune. The repo is single-replica today; the in-process
   `Map` covers the actual concurrency. The audit explicitly flagged
   store-side as "overkill for a single-replica setup."

2. **`redis-stampede` / `p-limit` libraries.** Rejected. Both add a
   third-party dependency for ~30 lines of code that a `Map<string,
   Promise<T>>` solves directly. The implementation also lives behind
   `ICachePort`, so a future swap to a library is a one-file change.

3. **Universal jitter inside `RedisCacheAdapter.set`.** Rejected for now.
   It would force the policy on every aggregate cache, including consumers
   that may want deterministic TTLs (e.g. a future fixture-driven test
   adapter). Aggregate-level jitter keeps the policy opt-in. Easy to
   promote later if every aggregate ends up duplicating the math.

4. **Schema-versioned key prefixes as the protection for CACHE-001.**
   Rejected as out-of-scope here. ADR-016 already tracks the
   schema-version segment as CACHE-003; that's a different concern (DTO
   shape evolution, not concurrent-miss dedupe).

5. **Single-flight wraps `cache.wrap` automatically.** Considered. Would
   give the `@Cacheable()` decorator path free single-flight too. Held
   back: `wrap` has no other production caller today and changing its
   semantics implicitly is a footgun. Future ADR can promote `wrap` to
   single-flighted if needed.

## Consequences

### Positive

- **Stampede bounded.** N concurrent misses on the same key produce one
  DB query per process. Single-replica deploys see full dedupe.
- **CACHE-001 race window collapsed.** The leader's `singleFlight` slot
  serializes the DB read + cache.set sequence; a concurrent invalidate
  arriving mid-leader still leaves a clean cache after invalidate runs
  (the leader's `set` writes the *current* DB result, and the next read
  re-fetches).
- **Expiry stampede mitigated.** ±10% jitter pushes correlated writes
  across an `0.2 * TTL` band; for the default 60 s TTL that's a 12-second
  spread.
- **Port-level primitive.** Every future aggregate cache (orders,
  customers) inherits `singleFlight` without re-implementing it.
- **ADR-002 contract preserved** — the new primitives are strict
  refinements, not relaxations.

### Negative / Trade-offs

- **Single-process scope.** Cross-replica stampedes still fan out one
  loader per replica. Acceptable at current scale (one replica per
  service); revisit if horizontal scale-out becomes load-bearing.
- **In-flight map growth.** Bounded by max-concurrent-distinct-cache-keys
  in flight at any moment. Entries are cleared on settlement, so the map
  cannot grow unboundedly under steady-state traffic. A pathological
  pattern (every request hits a unique key + loader hangs) could grow
  the map, but the same pattern already pins memory in the DB driver and
  is a separate failure mode.
- **Jittered TTL is no longer a round number.** Operations dashboards
  showing "expected expiry at T+60s" need to account for `[54s, 66s)`.
  The jitter band is documented inline at the call site.
- **`IStockCachePort` grew a method.** Implementations now have a third
  port surface to cover. Acceptable; the existing `get`/`set` are still
  exposed for callers that want explicit control.

## References

- [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md)
  — re-confirmation of CACHE-001 and CACHE-004 against post-migration code.
- [ADR-002](002-redis-cache-aside-product-stock.md) — original cache-aside
  contract; preserved verbatim.
- [ADR-006](006-cache-aside-via-libs-cache.md) — port-and-adapter shape
  this ADR extends.
- [ADR-016](016-cache-aside-generalized.md) — generalized key convention
  and `delByPrefix`; ADR-021 adds the matching single-flight primitive.
