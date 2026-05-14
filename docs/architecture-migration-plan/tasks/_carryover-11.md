# _carryover-11.md — Generalize cache-aside on read paths and invalidation on writes (Phase 7, cache)

> Generated 2026-05-14 by the task-11 session on branch
> `RIS-25-Architecture-migration`.
> The next task (`task-12`) reads this file as its first action and
> fails fast if it is missing.

## 1. Entry-gate result

`yarn install`, `yarn build` (4 apps), `yarn lint`, `yarn test:unit`
(130 tests across 27 suites) were all green at the start of the
session. Baseline matches `_carryover-10.md`'s reported state.

## 2. Read use cases decorated

The task brief asks for `@Cacheable` on read use cases "where it makes
sense" and TTL rationale. After enumerating every `get-*.use-case.ts`
and `list-*.use-case.ts` across apps, **no new caches** were added:

| Use case | Decision | Rationale |
|---|---|---|
| `GetStockUseCase` (inventory) | Keep existing cache-aside | Already wraps via `IStockCachePort` — preserved intact. Reads inside a caller-owned `EntityManager` or with `ignoreCache: true` bypass cache; `@Cacheable` cannot express those branches. TTL: `CACHE_TTL_MS_PRODUCT_STOCK` (default 60s). |
| `GetOrderUseCase.findHeaderById` (retail) | NOT cached | Called once per confirm RPC by the gateway's `OrderConfirmPipe`. The pipe's whole purpose is to short-circuit a non-PENDING confirm — caching the status would mask the very transition the pipe checks. |
| `GetProductStockUseCase` (api-gateway) | NOT cached | Thin RPC pass-through. Adding a gateway-side cache would create a two-tier topology with no invalidation channel from the inventory service back to the gateway. The inventory service already caches. |

There are no `list-*.use-case.ts` files today.

## 3. Centralized cache keys

`libs/cache/cache-keys.ts` was extended with the new convention:

```ts
export const CACHE_KEYS = {
  // New convention (ADR-016)
  inventoryStockPrefix: (productId) => `ris:inventory:stock:${productId}:`,
  inventoryStock: (productId, storageIds?) => {
    const facet = storageIds && storageIds.length > 0
      ? [...storageIds].sort((a, b) => a.localeCompare(b)).join(',')
      : '__all__';
    return `${CACHE_KEYS.inventoryStockPrefix(productId)}${facet}`;
  },
  retailOrderPrefix: (orderId) => `ris:retail:order:${orderId}`,
  retailOrder: (orderId) => CACHE_KEYS.retailOrderPrefix(orderId),
  // Legacy (kept stable through the deploy)
  productStockPrefix: (productId) => `stock:${productId}:`,
  productStock:        (productId, storageIds?) => …charCodeAt(0)…,
};
```

Audit findings closed by the new builder (per ADR-016):

- **CACHE-010** — full lexicographic compare via `localeCompare`.
- **CACHE-011** — `__all__` sentinel (non-glob).

The legacy builder is retained unchanged so the SCAN-based invalidate
path can wipe entries written under the previous prefix during a
rolling deploy. New code never writes through the legacy builder; old
keys age out via TTL (default 60s).

`CacheHelper` continues to re-export the legacy builders for the one
release before task-14's cleanup.

## 4. `ICachePort.delByPrefix` (new primitive)

Added to `libs/cache/cache.port.ts`:

```ts
delByPrefix(prefix: string): Promise<number>;
```

Implemented in `libs/cache/redis-cache.adapter.ts`. The adapter
traverses `cache.stores[0].store` (the Keyv → KeyvRedis chain — the
previous `cacheable.primary.store` path was always undefined; the
old code silently fell through to a named-key fallback) and issues
`SCAN MATCH ${prefix}*` followed by `UNLINK [...matchedKeys]`. On
non-Redis backends the method returns 0 and stale entries expire on
TTL.

Span attributes on `cache.delByPrefix`: `cache.prefix`,
`cache.backend` (`redis` | `non-redis` | `redis-no-scan`),
`cache.keys_unlinked`.

## 5. Stock cache adapter (re-shaped)

`apps/inventory-microservice/src/modules/stock/infrastructure/cache/`:

- File `stock-redis.cache.ts` → renamed to `stock.cache.ts`.
- Class `StockRedisCache` → renamed to `StockCache`.
- The class now depends only on `CACHE_PORT` (via `@Inject(CACHE_PORT)`)
  and `CACHE_KEYS`. No `@nestjs/cache-manager`, `@keyv/redis`,
  `cacheable`, or raw `Cache` imports.
- `get` / `set` use `CACHE_KEYS.inventoryStock(productId, storageIds)`.
- `invalidate` fans `port.delByPrefix(...)` over both prefixes per
  unique productId:
  - `CACHE_KEYS.inventoryStockPrefix(productId)` (new)
  - `CACHE_KEYS.productStockPrefix(productId)` (legacy, transition)
- Sums the returned unlink counts and emits a single `Stock cache
  invalidated via prefix delete` debug log.

`apps/inventory-microservice/src/app/app.module.ts` was switched from
`CacheModule` of `@nestjs/cache-manager` to `CacheModule` of
`@retail-inventory-system/cache`. `libs/cache/cache.module.ts` is now
`@Global()` so feature modules can inject `CACHE_PORT` without
re-importing.

## 6. Invalidation contract

`ReserveStockForOrderUseCase` previously issued the invalidate as
fire-and-forget (`void this.stockCache.invalidate(...).catch(...)`).
Task-11 switches it to **awaited**:

```ts
if (invalidateItems.length > 0) {
  await this.stockCache.invalidate({ items: invalidateItems, correlationId });
}
```

Rationale (also in ADR-016 §3): the confirm RPC's post-state now
includes "cache cleared for the mutated products" — the immediate next
GET reads fresh DB. The SCAN+UNLINK cost is a few ms on typical key
sets; UNLINK frees memory asynchronously. Tightens the test contract
and removes a latent flake source.

Note: this does NOT close `CACHE-001` (the reader-races-writer window
inside cache-aside). That race remains TTL-bounded.

## 7. Trace spans on cache ops

`RedisCacheAdapter` opens an OTel span around every operation:

| Span | Attributes |
|---|---|
| `cache.get`         | `cache.key`, `cache.hit` |
| `cache.set`         | `cache.key`, `cache.ttl_ms` |
| `cache.del`         | `cache.key` |
| `cache.wrap`        | `cache.key`, `cache.hit` |
| `cache.delByPrefix` | `cache.prefix`, `cache.backend`, `cache.keys_unlinked` |

Cache hits/misses are now visible in Jaeger alongside the auto-
instrumentation's `redis-*` spans (which still emit for the underlying
GET/SET/UNLINK roundtrips). Per finding-09 of `_carryover-10.md`,
ADR-016 §5 records this addition.

## 8. Files changed

### Updated

| Path | Change |
|---|---|
| `libs/cache/cache.port.ts` | Added `delByPrefix` to `ICachePort`. |
| `libs/cache/redis-cache.adapter.ts` | Implemented `delByPrefix`; fixed `getRedisAdapter` to traverse `cache.stores[0].store` (the previous `cacheable.primary` path never resolved); added OTel spans to every op. |
| `libs/cache/cache.module.ts` | Marked `@Global()` so child modules inject `CACHE_PORT` without explicit imports. |
| `libs/cache/cache-keys.ts` | Added `inventoryStock*` (new convention, CACHE-010/CACHE-011 fixes) and `retailOrder*` builders. Legacy `productStock*` retained for transition. |
| `libs/cache/spec/redis-cache.adapter.spec.ts` | Added `delByPrefix` coverage; updated store stub to use `cache.stores[0].store`. |
| `libs/cache/spec/cache-keys.spec.ts` (new) | Locks in CACHE-010 / CACHE-011 fixes plus legacy builder shape. |
| `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts` | (Renamed from `stock-redis.cache.ts`.) Now depends on `CACHE_PORT` + `CACHE_KEYS`; no `@nestjs/cache-manager`/`@keyv/redis`/`cacheable` imports. |
| `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts` | (Renamed from `stock-redis.cache.spec.ts`.) Rewritten to assert against `ICachePort` mock. |
| `apps/inventory-microservice/src/modules/stock/infrastructure/cache/index.ts` | Export path update. |
| `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts` | Class rename `StockRedisCache` → `StockCache`. |
| `apps/inventory-microservice/src/app/app.module.ts` | Uses `CacheModule` from `@retail-inventory-system/cache` instead of `@nestjs/cache-manager`. |
| `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts` | Awaits invalidation post-commit. |
| `test/system-api.e2e-spec.ts` | Switched cache prime/assert helpers to `CACHE_KEYS.inventoryStock`. |
| `README.md` | "Caching" section rewritten for the new key shape, awaited invalidation, and tracing. |
| `CLAUDE.md` | Updated the `@retail-inventory-system/cache` description, the inventory `stock.module.ts` map, added the cache-key-naming rule, bumped the next ADR counter (015→017), and revised the Known Issues bullet. |
| `docs/audits/audit-2026-05-08.md` | CACHE-006 / CACHE-010 / CACHE-011 / CACHE-012 marked resolved-by / superseded-by task-11 / ADR-016. |

### Created

| Path | Role |
|---|---|
| `docs/adr/016-cache-aside-generalized.md` | ADR — generalized cache-aside, `ris:` key convention, `delByPrefix` primitive, awaited invalidation, audit closures. |

## 9. Verification results

```
$ yarn install        — Done in 2s 451ms
$ yarn build          — 4 apps compiled successfully
$ yarn lint           — clean (exit 0)
$ yarn test:unit
  Test Suites: 28 passed, 28 total
  Tests:       138 passed, 138 total          (net new: +1 suite, +8 tests)
$ yarn test:e2e
  Test Suites: 3 passed, 3 total
  Tests:       35 passed, 35 total
  Snapshots:   42 passed, 42 total
```

Verification gates:

- `grep -rE 'redis|cache-manager|keyv' apps/*/src` → no production matches. The only matches were a filename and two test error-message literals, all cleared by renaming `stock-redis.cache.ts` → `stock.cache.ts` and re-wording the test messages.
- `grep -rEn "'(ris:|stock:|cache:)[^']*'" apps/*/src` → matches only in spec files (asserting the production-contract literal). No production string-literal cache keys remain.

Net new in unit suite:
- `libs/cache/spec/cache-keys.spec.ts` (new, 8 tests).
- `libs/cache/spec/redis-cache.adapter.spec.ts` (+6 `delByPrefix` tests).
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts` (rewritten, 11 tests vs the previous 16 — the SCAN-path tests moved into the lib spec; the stock-side tests now assert against the port instead of `Cache`/`KeyvRedis`).

## 10. Audit findings closed by this task

| Code | Status before | Status after |
|---|---|---|
| `CACHE-006` (layer reach-through fragility) | unresolved | resolved by task-11 / ADR-016 — reach-through is in `libs/cache` only |
| `CACHE-010` (sort comparator) | unresolved | resolved — `CACHE_KEYS.inventoryStock` uses `localeCompare` |
| `CACHE-011` (literal-`*` sentinel) | unresolved | resolved — `__all__` sentinel |
| `CACHE-012` (combo-key fallback) | unresolved | superseded — `invalidateNamedKeys` removed; non-Redis path is a documented no-op |

Still open (no change):

- `CACHE-001` (cache-aside race / single-flight)
- `CACHE-002` (post-commit contract enforced by comment — the contract is now stricter because invalidate is awaited, but the comment remains the only enforcement of "after commit")
- `CACHE-003` (no schema-version segment in keys)
- `CACHE-004` (no TTL jitter)
- `CACHE-005` (duplicate warn logs on Redis-down)
- `CACHE-007` / `CACHE-008` (missing skip-cache / tx-failure coverage)
- `CACHE-009` (no tenant segment)
- `TEST-001` / `TEST-002` / `TEST-003` / `CODE-001` / `DOCS-001` (unchanged)

## 11. Unexpected findings

1. **`Cacheable.primary.store` was a dead path.** The original
   `StockRedisCache.getRedisAdapter()` cast `Cache` (the
   `@nestjs/cache-manager` provider) to a `Cacheable`-shaped object
   and read `.primary.store`. But `cache-manager`'s `createCache`
   returns an object with a `stores` array, **not** a `primary`
   accessor. Result: `getRedisAdapter()` always returned `undefined`,
   and the invalidation path always fell through to
   `invalidateNamedKeys` (the explicit-key fallback). The SCAN+UNLINK
   path that ADR-002 and CLAUDE.md describe was never actually
   exercised in production despite the unit tests stubbing the path
   directly. The new `RedisCacheAdapter.getRedisAdapter()` traverses
   `cache.stores[0].store` to actually reach `KeyvRedis`.

2. **The e2e test was relying on a race.** The original
   `ReserveStockForOrderUseCase.invalidate` was fire-and-forget; the
   e2e test in `test/system-api.e2e-spec.ts` asserted that after the
   PUT response, the cache was already cleared. That assertion was
   timing-dependent. With the new path actually doing real SCAN+UNLINK
   (vs the old named-key `cache.del`), the race tipped over. Switching
   `invalidate` to `await` (ADR-016 §3) restored the contract on a
   firmer foundation.

3. **`CacheModule` was being imported from `@nestjs/cache-manager`
   directly in `apps/inventory-microservice/src/app/app.module.ts`.**
   That violated the verification gate. Switched to `CacheModule` from
   `@retail-inventory-system/cache` and made the lib module
   `@Global()` so feature modules don't need to re-import it.

4. **`task-04`'s `@Cacheable` decorator was never reached for in this
   task.** No read use case in the codebase fits the decorator's
   single-call read-through shape — `GetStockUseCase` has multiple
   skip-cache branches that the decorator cannot express. The
   decorator remains in `libs/cache/decorators/` for future use; the
   audit-findings around it (lazy DI resolution against
   `ApplicationContextHost`) are deferred to the first real consumer.

5. **`@retail-inventory-system/common` still re-exports
   `CacheHelper`.** Removed in task-14 along with the rest of the
   common-shim subfolders.

## 12. Suggested adjustments to task-12 (`boundaries` rules)

When task-12 wires `eslint-plugin-boundaries`:

1. Allow `apps/*/src/modules/*/infrastructure/cache/**` to import
   from `@retail-inventory-system/cache` (`CACHE_PORT`, `ICachePort`,
   `CACHE_KEYS`).
2. Forbid `apps/*/src/**` from importing `@nestjs/cache-manager`,
   `@keyv/redis`, `cacheable`, or `redis` directly — these are
   `libs/cache`-only deps. The grep gate enforced this in task-11;
   the lint rule cements it.
3. Domain code (`apps/*/src/modules/*/domain/**` and `libs/ddd/**`)
   continues to be forbidden from importing
   `@retail-inventory-system/cache` (or any infrastructure lib).

## 13. Open follow-ups (post-task-11)

1. **Audit-findings `CACHE-001` / `CACHE-002` / `CACHE-003` /
   `CACHE-004` / `CACHE-005` / `CACHE-009`** still apply. A future
   pass that introduces single-flight (e.g. `p-limit` per key) would
   address `CACHE-001` and `CACHE-004` simultaneously; a tenant
   model would address `CACHE-009`.
2. **`@Cacheable` decorator** lacks a real-world consumer. When the
   first list-style read use case arrives, drive the decorator
   through it and fix the lazy-DI question raised in task-04.
3. **Notification consumer span duration** still inflated (per
   `_carryover-10.md` finding #3). Untouched here.
4. **No integration test against real Redis** for `delByPrefix`. The
   lib spec uses a hand-rolled `scanIterator` / `unlink` stub; the
   e2e suite exercises the full path through the inventory service
   (where it caught the dead-path bug above). A dedicated integration
   test that hits the real `RedisCacheAdapter` against `test:infra:up`
   would be a small confidence boost; deferred.
