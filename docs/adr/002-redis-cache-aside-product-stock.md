# ADR-002: Use Redis Cache-Aside for Product Stock Queries

- **Date**: 2026-05-08
- **Status**: Accepted

---

## Context

The Inventory microservice exposes a stock query endpoint (`GET /api/product/:productId/stock`, served via the `INVENTORY_PRODUCT_STOCK_GET` RPC). Stock is not stored as a current-balance row but as an append-only `product_stock` ledger: every reservation, restock, or adjustment writes a new row with a positive or negative `quantity` against a `(productId, storageId)` pair. Producing a current balance therefore requires a `SUM(quantity) ... GROUP BY storageId` aggregation over every row for the product.

This works correctly but does not scale. Aggregation cost grows linearly with the number of ledger rows per product. The access pattern is read-heavy (every order flow touches stock; many flows touch it more than once) and write-light (a row is appended only on order confirmation or restock). Repeating the same `GROUP BY` aggregation for every read wastes DB time on results that change infrequently.

A cache layer is the natural fit, but it has to interact correctly with the order-confirmation transaction: stock data goes stale the moment a confirm commits, and serving stale stock to a downstream order check could oversell.

---

## Decision

Adopted the **cache-aside (lazy loading)** pattern with Redis as the backing store.

The cache lives in a shared `ProductStockCommonService` façade in the Inventory microservice. Both the read API (`ProductStockGetService`) and the write API (`ProductStockOrderConfirmService`) go through it, which is what makes consistent invalidation possible.

**Read path (`ProductStockCommonService.get`):**

1. If the call carries a caller-owned `EntityManager` or `ignoreCache: true`, skip the cache and read directly from the DB. (A read inside an open transaction can see uncommitted rows; caching that data would corrupt the shared cache for other callers.)
2. Otherwise, look up the key via `ProductStockCommonCacheService.get`. A hit returns the cached `ProductStockGetResponseDto`.
3. On miss, run the DB aggregation via `ProductStockCommonGetService.execute`.
4. Write the result back via `ProductStockCommonCacheService.set` with a TTL of `CACHE_TTL_MS_PRODUCT_STOCK` (default `60000` ms).

**Cache key format** (`CacheHelper.keys.productStock` in `libs/common/cache/cache.helper.ts`):

```
stock:<productId>:<sorted-storageIds-joined-by-comma>
stock:<productId>:*                  # when no storageIds filter is supplied
```

**TTL** is configured via two env vars: `CACHE_TTL_MS_DEFAULT` (the global Cache-module default applied to any unscoped `set()`) and `CACHE_TTL_MS_PRODUCT_STOCK` (used explicitly when caching a stock query response). Both default to `60000` ms. TTL is a safety net — explicit invalidation is the primary freshness mechanism.

**Invalidation** runs in `ProductStockOrderConfirmService` after the order-confirm transaction commits. It is fire-and-forget — the RPC reply is not blocked on cache work. Implementation reaches through `@nestjs/cache-manager` to the underlying `@keyv/redis` client and runs `SCAN MATCH stock:<productId>:*` per affected `productId` in parallel, then `UNLINK`s every matching key. `UNLINK` is preferred over `DEL` because it frees memory asynchronously on the Redis side. A defensive fallback path uses named-key `DEL` for non-Redis backends (e.g. an in-memory store swapped in for unit tests).

Calling invalidation before commit was rejected: a concurrent reader could re-populate the cache from uncommitted state and then the transaction could roll back, leaving cache and DB divergent.

**Graceful degradation:** every cache operation (`get`, `set`, `invalidate`) is wrapped in `try/catch`. Errors are logged at `warn` and swallowed. A failed `get` returns `undefined` (the same contract as a miss) and the façade falls through to the DB. A Redis outage degrades latency, never correctness.

---

## Alternatives Considered

1. **NestJS `CacheInterceptor` (HTTP-layer caching)** — rejected. It caches at the HTTP handler boundary in the API gateway, not where stock state actually lives (the Inventory microservice). It has no concept of an internal write event such as a confirmed order, so there is no clean way to invalidate a cached response when the underlying ledger changes. It would also miss the RPC code path entirely (other microservices that call `INVENTORY_PRODUCT_STOCK_GET` over RabbitMQ never touch the HTTP gateway).

2. **Write-through cache** — rejected. Write-through assumes the cache value is the same shape as what was written, so a `set()` on write keeps the cache in sync. The `product_stock` table is append-only and stores per-row deltas; the cached value is a `SUM ... GROUP BY` aggregation. A new ledger row does not let you compute the new aggregation without re-reading the DB, which removes the point of write-through and adds a write-path cost. Cache-aside with explicit invalidation is a better match for an append-only ledger.

3. **In-memory cache (no Redis)** — rejected. A per-process in-memory cache would be fastest for the single-instance case, but the Inventory microservice is deployed to be horizontally scalable and `INVENTORY_PRODUCT_STOCK_GET` is consumed from a shared RabbitMQ queue. Per-instance caches would diverge — instance A's cache would not see instance B's invalidation, producing inconsistent reads across replicas. Centralising on Redis avoids that class of bug at the cost of one extra network hop.

---

## Consequences

### Positive

- **Lower read latency on cache hits.** A hit is one Redis round-trip; a miss is one Redis round-trip plus a `SUM`/`GROUP BY` on the ledger. As ledger volume grows, the gap widens.
- **DB load drops on the read path.** Repeated reads for the same `(productId, storageIds)` combination are served from Redis for the TTL window, which is meaningful for any flow that fetches stock more than once per request lifecycle.
- **Read scalability.** The expensive aggregation runs once per cache miss instead of once per request, so adding more Inventory replicas does not multiply DB load proportionally.
- **No correctness regression on Redis failure.** Read, write, and invalidation errors are logged and swallowed; the system always falls back to the DB.

### Negative / Trade-offs

- **Redis is now a runtime dependency on the Inventory microservice's read path.** It was previously provisioned but unused. Operationally, Redis must be monitored and sized; a Redis brownout will silently increase DB read load.
- **Invalidation latency added to the write path.** Each successful order confirm triggers a parallel SCAN-per-product followed by UNLINK. SCAN is incremental and `COUNT` is set to `100` per cycle, so cost is bounded, but it is non-zero. Mitigated by running invalidation as fire-and-forget after commit.
- **Bounded staleness window on Redis outage.** If a confirm commits but invalidation cannot reach Redis, cached stock for the affected `(productId, storageId)` keys remains stale until TTL expiry (default 60 s). Acceptable for the current scale; revisit if business rules tighten.
- **Cache-aside read/write race.** Between a cache miss and the subsequent `cache.set`, a concurrent writer could commit and invalidate, after which the original reader writes the now-stale DB result back. No single-flight or version-stamping today; the staleness is bounded by TTL. Tracked as `AUDIT-2026-05-08 [CACHE-001]`.
- **Cache shape is typed at compile time only.** A breaking change to `ProductStockGetResponseDto` would deserialize old in-flight entries without runtime validation for one TTL window. Future mitigation: a schema-version segment in the key (e.g. `stock:v2:<productId>:...`). Tracked as `AUDIT-2026-05-08 [CACHE-003]`.
