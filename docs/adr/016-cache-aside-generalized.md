# ADR-016: Generalized cache-aside — `ris:<service>:<aggregate>:<id>` keys + port-based invalidation

- **Date**: 2026-05-14
- **Status**: Accepted (key shape, invalidation seam, and the "Still open" register superseded in part by ADR-021 → ADR-022 → ADR-023; see References)

---

## Context

[ADR-002](002-redis-cache-aside-product-stock.md) introduced cache-aside for the product-stock query in the inventory microservice. The wiring lived in `apps/inventory-microservice/src/.../product-stock-common.service.ts` and reached directly into `@nestjs/cache-manager`, `@keyv/redis`, and `cacheable` to perform SCAN+UNLINK invalidation.

Task-04 of the architecture migration extracted a generic cache abstraction into `libs/cache`: `ICachePort` (get/set/del/wrap), `CACHE_PORT` (DI symbol), `RedisCacheAdapter` (concrete impl over `@nestjs/cache-manager` + `@keyv/redis`), a `CACHE_KEYS` registry, and a `@Cacheable()` decorator skeleton. Task-08 moved the stock-cache façade into `apps/inventory-microservice/src/modules/stock/infrastructure/cache/` but it still reached `@nestjs/cache-manager` directly to perform SCAN+UNLINK.

By task-11 the audit in `docs/audits/audit-2026-05-08.md` had identified twelve `CACHE-*` findings. Three of them are key-shape bugs (`CACHE-010` storage-id sort comparator, `CACHE-011` literal-`*` sentinel) and one is an architectural fragility (`CACHE-006` `cacheable` reach-through). The rest are open architecture/config items that don't block generalization.

Task-11's brief: generalize the cache layer so apps depend only on `libs/cache` (no direct `cache-manager`/`keyv`/`redis` imports in `apps/*/src`), centralize cache keys in `libs/cache/cache-keys.ts`, and address the audit's key-shape bugs en route.

## Decision

### 1. Key convention

Every new cache key follows `ris:<service>:<aggregate>:<id>[:<facet>]`. The leading `ris:` prefix scopes the cache to this project (the Redis instance may be shared with adjacent services); `<service>` and `<aggregate>` qualify the key so that cross-aggregate collisions are impossible by construction.

Builders live in `libs/cache/cache-keys.ts` and are exported as `CACHE_KEYS.*`. Apps under `apps/*/src` MUST NOT write cache-key string literals — every key comes from a builder. Specs may assert literal strings (they're locking in the production contract).

Existing keys under the legacy `stock:<productId>:*` prefix continue to be invalidated through the post-deploy transition window (see §3 below). They are not actively written to by new code; they age out via TTL.

### 2. `delByPrefix` on the cache port

Multi-key invalidation requires iterating a key set on the cache backend. The previous design reached through `Cache → Cacheable.primary → store → KeyvRedis → adapter.client` to issue SCAN+UNLINK. That reach-through is fragile against `cacheable` major-version bumps (`CACHE-006`) and forces every app that needs multi-key invalidation to repeat the same dance.

Task-11 adds `delByPrefix(prefix: string): Promise<number>` to `ICachePort`. The `RedisCacheAdapter` implementation traverses `cache.stores[0].store` (the Keyv → KeyvRedis chain) and issues `SCAN MATCH ${prefix}*` followed by `UNLINK [...matchedKeys]`. On backends without a Redis adapter (e.g. an in-memory store under unit tests) it returns 0; the call is a no-op there, and stale entries expire via TTL.

Apps invalidate via `CACHE_KEYS.<aggregate>Prefix(...)` + `port.delByPrefix(...)`. The stock adapter (`StockCache` in the inventory microservice) wraps the port and exposes a domain-shaped `invalidate({ items, correlationId })` that fans `delByPrefix` per unique productId. It calls `delByPrefix` once for the new prefix and once for the legacy `stock:` prefix so entries written before the cut-over are wiped on the first post-deploy write.

### 3. Awaited invalidation post-commit

Pre-task-11, `ReserveStockForOrderUseCase` issued the invalidate as fire-and-forget (`void this.stockCache.invalidate(...)`). The comment justified that as a latency optimization: the SCAN+UNLINK was free to overlap with the RPC reply.

Task-11 changes this to `await this.stockCache.invalidate(...)`. The post-state of a successful confirm RPC now includes "cache cleared for the mutated products" — the immediate next GET reads the fresh DB row. The SCAN+UNLINK cost is a few milliseconds on a small key set, paid for tighter semantics and a deterministic test contract.

This does NOT close `CACHE-001` (the read/write race between a reader's DB read and a writer's commit+invalidate); that race is bounded by TTL today and is tracked for a future single-flight / version-stamp pass.

### 4. Audit findings closed by this ADR

- **CACHE-010** (sort comparator): the new `CACHE_KEYS.inventoryStock` builder sorts storage IDs via `localeCompare`, so any pair of storage-id permutations produces the same key.
- **CACHE-011** (literal-`*` sentinel): the new "all-storages" sentinel is `__all__` (non-glob).
- **CACHE-006** (layer reach-through): the only place that reaches through to `KeyvRedis` is `libs/cache/redis-cache.adapter.ts`. Apps depend on `ICachePort`. A `cacheable` major bump now lands in one lib file, not in every app.

### 5. Tracing

`RedisCacheAdapter` opens an OTel span around every operation (`cache.get`, `cache.set`, `cache.del`, `cache.wrap`, `cache.delByPrefix`) with `cache.key`/`cache.prefix`, `cache.hit` (for read paths), and `cache.keys_unlinked` (for prefix deletes). Cache hit/miss is now visible in Jaeger alongside the existing `redis-*` spans the auto-instrumentation emits.

## Consequences

- One-deploy transition window where entries under the legacy `stock:` prefix coexist with entries under `ris:inventory:stock:`. Invalidation covers both; reads only resolve through the new prefix; legacy entries that never get a write expire on TTL (default 60s).
- Verification gate (task-11): `grep -rE 'redis|cache-manager|keyv' apps/*/src` returns zero matches. The class `StockRedisCache` was renamed to `StockCache` and the file `stock-redis.cache.ts` to `stock.cache.ts` to satisfy the gate by name as well as by import.
- `CACHE_PORT` is provided by `@Global()` `CacheModule` in `libs/cache`. Feature modules can inject it without importing the module explicitly.
- Confirm-RPC latency increases by the SCAN+UNLINK cost. Acceptable: typical key sets are small, UNLINK frees memory asynchronously, and the previous fire-and-forget was a latent test-flake source.

## Still open

- `CACHE-001` (cache-aside read/write race / no single-flight)
- `CACHE-002` (post-commit invalidate contract enforced by comment)
- `CACHE-003` (no schema-version segment in keys)
- `CACHE-004` (no TTL jitter)
- `CACHE-005` (duplicate warn logs on Redis-down)
- `CACHE-007` / `CACHE-008` (missing skip-cache / tx-failure coverage)
- `CACHE-009` (no tenant segment)
- `CACHE-012` (combo-key fallback only covers single-storage keys; no longer reachable because `delByPrefix`'s non-Redis path is a documented no-op)

## References

The §Decision and §"Still open" sections above are the historical task-11 snapshot. The three forward pointers below redirect a reader to the current state of the cache layer.

- [ADR-021](021-cache-single-flight-and-ttl-jitter.md) — adds `ICachePort.singleFlight(key, fn)` (in-process leader/follower coalescing on the miss path) and ±10% TTL jitter on the `StockCache` write path. The "DOES NOT close `CACHE-001`" caveat in §3 above and the `CACHE-001` / `CACHE-004` rows of §"Still open" are closed here. `IStockCachePort.getOrLoad(payload, loader)` composes `get → singleFlight(loader+set)` so stock read paths no longer compose the steps by hand.
- [ADR-022](022-cache-keys-tenant-and-schema-version.md) — inserts a per-aggregate schema-version segment and an opt-in `t:<tenantId>:` segment into every key. The `ris:<service>:<aggregate>:<id>[:<facet>]` literal in §1 above is now `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`, reachable only via `CACHE_KEYS.*` builders. Per-aggregate version constants (`INVENTORY_STOCK_KEY_VERSION`, `RETAIL_ORDER_KEY_VERSION`) sit next to the builders in `libs/cache/cache-keys.ts`. The `CACHE-003` / `CACHE-009` rows of §"Still open" are closed here.
- [ADR-023](023-cache-invalidate-post-commit-by-type.md) — replaces the `await this.stockCache.invalidate(...)` pattern in §3 above with a type-enforced `IStockCachePort.withInvalidation(work, resolveItems, opts)` seam. `IStockCachePort` no longer exposes a public `invalidate(...)`; the post-commit ordering is enforced by the helper's signature, not by comment. The "once for the new prefix and once for the legacy `stock:` prefix" fan-out in §2 above is now three calls per productId during the ADR-022 transition window (current v1 `inventoryStockPrefix`, pre-v1 post-ADR-016 `inventoryStockLegacyPrefix`, pre-ADR-016 `productStockPrefix`), all private to `StockCache.invalidatePrefixes(...)`. The `CACHE-002` row of §"Still open" is closed here.
- `CACHE-005` (duplicate warn logs on Redis-down) is closed by the `IStockCachePort.get` return shape carrying an `{ value, available }` tuple — `getOrLoad` skips the write-back path when Redis is unreachable, collapsing the per-request warn-log count from three to one. No separate ADR documents this change; see CLAUDE.md §"Operational notes" for the runtime statement.
