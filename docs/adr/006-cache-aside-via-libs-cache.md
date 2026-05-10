# ADR-006: Cache-aside via `libs/cache` port and adapter

- **Date**: 2026-05-10
- **Status**: Accepted

---

## Context

[ADR-002](002-redis-cache-aside-product-stock.md) introduced a Redis
cache-aside pattern for product-stock queries. The implementation
lived under `libs/common/cache/cache.helper.ts` (key registry) and
`apps/inventory-microservice/.../product-stock-common-cache.service.ts`
(read/write/invalidate against `@nestjs/cache-manager`'s `Cache`
directly). Domain code therefore depended on the concrete `Cache`
type from `@nestjs/cache-manager`, which made unit tests stub out a
Nest-shaped dependency and tied the inventory façade to the specific
backend choice.

ADR-004 commits the codebase to a hexagonal architecture per service.
That means domain code must depend on **ports** (interfaces it owns)
rather than infrastructure types. Cache is one of the three I/O
concerns called out in the recommendation as needing a port-and-
adapter home (alongside messaging and observability).

This ADR records the shape we are introducing in task-04 to host
ADR-002's cache-aside contract behind a port — and the explicit
decision to **preserve** the contract verbatim while we restructure
the abstraction.

## Decision

Introduce `libs/cache` with the following exports:

| Export | Role |
|--------|------|
| `ICachePort` | The interface domain/façade code depends on. Methods: `get<T>`, `set<T>`, `del`, `wrap<T>` (read-through). |
| `CACHE_PORT` | DI token (`Symbol('CachePort')`) that binds the port to its adapter at the Nest container level. |
| `RedisCacheAdapter` | `@Injectable()` implementation of `ICachePort` against the existing `@nestjs/cache-manager` + `@keyv/redis` setup. |
| `CacheModule` | Nest module that imports `NestCacheModule.registerAsync(cacheModuleConfig)` and binds `CACHE_PORT → RedisCacheAdapter`. |
| `cacheModuleConfig` | Relocated from `libs/config` — the existing factory, unchanged. |
| `CACHE_KEYS` | Function-valued key registry. Templates produce identical strings to the previous `CacheHelper.keys` so production cache entries survive the deploy. |
| `CacheHelper` | Backwards-compat shim that delegates to `CACHE_KEYS`. Kept for one release; the inventory façade migrates off it in task-08. |
| `@Cacheable({ key, ttlMs })` | Method decorator that wraps a method in `port.wrap(...)` for opt-in read-through caching. Generalized application is task-11. |

The `wrap` method is the cache-aside contract: domain code calls
`cache.wrap(key, ttl, () => loadFromDb())` and never sees the cache
miss/hit branches. Adapters are free to add jitter, schema-version
prefixes, or stampede protection without changing the call site.

### Relationship to ADR-002

ADR-002 keeps **Status: Accepted**. This ADR refines its abstraction
without changing its contract:

- TTL behaviour (default 300 s, per-key override via
  `CACHE_TTL_MS_PRODUCT_STOCK`) — unchanged.
- Cache key prefix (`stock:<productId>:`) and `*` sentinel for the
  unfiltered key — unchanged. The audit comments (CACHE-009 through
  CACHE-012) are preserved verbatim in `libs/cache/cache-keys.ts`.
- SCAN+UNLINK invalidation in the inventory façade — unchanged in
  task-04. Task-08 migrates the façade onto `ICachePort` and decides
  whether `del` should grow a `delByPattern` overload to absorb the
  invalidation logic.

### What this ADR explicitly does **not** decide

- The 17 open audit items from `docs/audits/audit-2026-05-08.md`
  remain open. Task-11 re-evaluates them — task-04 only restructures
  the abstraction.
- A second adapter (in-memory, multi-tier) is out of scope. The port
  is shaped to support one but no second adapter ships in task-04.

## Consequences

- **+** Domain code can be tested with a `Map`-backed stub of
  `ICachePort` instead of mocking `@nestjs/cache-manager`.
- **+** Future moves (in-memory adapter for tests, multi-tier with
  L1 in-process + L2 Redis) require no domain changes.
- **+** Decorator-based caching at consumers becomes mechanical.
- **−** Two paths into the same Redis instance for one release
  (façade-via-`CacheHelper` and adapter-via-port) until task-08
  consolidates. Acceptable because both paths produce identical
  keys.

## Alternatives considered

- **Keep `CacheHelper` as-is.** Rejected: leaves domain code coupled
  to `@nestjs/cache-manager`, blocks ADR-004's hexagonal target.
- **Inject `Cache` from `@nestjs/cache-manager` directly with a
  service wrapper.** Rejected: the wrapper would still be in the app
  layer, every consumer would re-wrap, and the boundary rule
  enforcement in task-12 would have nothing to grep for.
