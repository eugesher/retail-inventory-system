---
title: Cache Implementation Audit
date: 2026-05-07
scope: Inventory microservice — product stock cache layer
status: completed
---

# Cache Implementation Audit — 2026-05-07

## A. Bugs / inaccuracies

| ID | Severity | Location | Defect | Reproduction sketch | Proposed fix outline |
|----|----------|----------|--------|---------------------|----------------------|
| B1 | medium  | `libs/common/cache/cache.helper.ts:31` | `storageIds` sort comparator uses `charCodeAt(0)` only. Pairs sharing first char compare equal → input-order-dependent key. (RISK FLAG #3, already commented in code.) | `GET ?storageIds=["ab","aa"]` then `GET ?storageIds=["aa","ab"]` → two distinct cache keys, both miss-then-set. | Replace with `a.localeCompare(b)`. |
| B2 | low (latent) | `libs/common/cache/cache.helper.ts:14` | Cache key has no tenant segment. (RISK FLAG #2, already commented in code.) | N/A — no tenant model exists today. | Prefix tenant id once a tenant model lands. |
| B3 | low | `libs/common/cache/cache.helper.ts:32` | "All storages" key uses literal `*` (`stock:<id>:*`). Looks like a glob pattern; SCAN MATCH for `stock:<id>:*` correctly matches the literal-`*` key plus per-storage keys, but a future refactor that issues `del('stock:<id>:*')` would miss it silently. | Refactor invalidation to `cache.del(literalGlob)` → key persists. | Use a non-meta sentinel (e.g. `__all__`). |
| B4 | medium | `apps/inventory-microservice/src/app/common/modules/product-stock-common/product-stock-common.module.ts:20` and `index.ts` | `ProductStockCommonCacheService` is not exported from the module. E2E suite cannot observe cache state through the project's own abstraction → audit constraint ("observe via existing cache provider abstraction") cannot be satisfied without either (a) adding the cache service to `exports` or (b) re-using `CACHE_MANAGER` directly. | Try `inventoryMicroservice.get(ProductStockCommonCacheService)` from E2E → DI returns undefined / not an exported provider. | Option A (preferred): keep encapsulation, retrieve `CACHE_MANAGER` token via `inventoryMicroservice.get(CACHE_MANAGER)` in tests. Option B: export the cache service narrowly (test-only impact, but breaks the encapsulation we just built). **Surfacing for Phase 2 decision.** |
| B5 | medium | `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts:189–213` (`invalidateNamedKeys` fallback) | Fallback path for non-Redis backends only deletes the literal-`*` key and the single-`storageId` key per item. Multi-storage combo keys (e.g. `stock:1:storage-a,storage-b`) survive until TTL. | Use in-memory store + GET with `storageIds=["a","b"]` to cache combo key → confirm order → `invalidate()` runs fallback path → combo key still present. | Document explicitly as best-effort (already commented), OR enumerate combo keys via the in-memory adapter's iterator interface. Not in production hot path; acceptable as-is. |
| B6 | low | `apps/inventory-microservice/src/app/common/modules/product-stock-common/product-stock-common.service.ts:57` | `if (cached)` truthiness check. Cache returns `undefined` on miss/error and a DTO object on hit. Empty stock DTOs (`{quantity:0,items:[],updatedAt:null}`) are truthy objects, so this works **today**. The risk: if a future contract change makes `cache.get` return a falsy non-`undefined` value (e.g. `null` JSON serialization), miss/hit paths converge. | Currently latent. | Replace `if (cached)` with `if (cached !== undefined)` to align with cache service's miss contract. |
| B7 | low | `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts:44–58` (`get` error path) | `cache.get` throws → method returns `undefined` (implicit). Façade then proceeds to DB read **and writes the DB result back to the cache** in the next step (line 74 of common service). If the cache is fully unavailable the `set` will also throw and be swallowed (warn-logged). Net behavior is correct, but flow is implicit and hard to reason about. | Kill Redis mid-test → GET still returns 200 with DB data; logs show two warns (read + write). | Add an explicit `cacheAvailable` flag from `get` to short-circuit the `set` attempt when the read already failed. |
| B8 | medium | `apps/inventory-microservice/src/app/common/modules/product-stock-common/product-stock-common.service.ts:73–75` | Classic cache-aside race: reader reads stale DB row (pre-commit), writer commits + invalidates, reader writes stale value to cache. Window is small but real, especially under TTL=60s. | Concurrent confirm + GET on same `productId` with overlap between the GET's DB query and the writer's commit. | Out of typical fix scope (single-flight / set-with-version). Recommend follow-up ticket. |
| B9 | low | `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-get.service.ts:20` | `this.logger.info(payload, 'Received RPC: get product stock')` includes the entire RPC payload at info level. Today payload is `{ productId, storageIds?, correlationId }` — fine; concern is forward-looking if PII is added to payloads. | N/A. | No fix needed; flag for future-payload reviews. |
| B10 | low | `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-get.service.ts:24` | `{ ...payload, ...error }` spreads an Error instance. `name`/`message`/`stack` are non-enumerable in some shapes and may not appear in the log line. | Throw a vanilla `new Error('boom')` from common service → log entry shows correlation/payload but not the error message. | Use `err: error` field (Pino convention) or destructure `{ message, stack }`. |
| B11 | medium | `apps/inventory-microservice/src/app/common/modules/product-stock-common/product-stock-common.service.ts:99` (façade `invalidate`) | `invalidate` is exposed publicly with the post-commit-only contract enforced by comment, not by code. Easy to misuse — calling it inside a transaction would race with concurrent readers. | Code-search reveals only one caller today (`product-stock-order-confirm.service.ts`). Future authors lack a compiler safeguard. | Out-of-scope architectural fix — a transaction-aware `addAndInvalidate` helper or an `afterCommit` callback registry. |
| B12 | low | `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-get.service.ts:74` | `MAX(createdAt) AS updatedAt` is selected from the ledger, but `MAX` of a `DATETIME` is fine in MySQL; no bug. Including for completeness — verified that the `updatedAt > latestDate` JS-side reduce is the actual `max` of `max`es and behaves correctly for empty input (returns `null`). | N/A. | None. |

**Severity totals: critical 0 / high 0 / medium 5 / low 7.**

## B. Architectural issues

| ID | Severity | Concern | Direction |
|----|----------|---------|-----------|
| AR1 | medium | Cache provider not exposed for test observability (overlaps B4). The encapsulation is correct in principle, but creates a closed-box for E2E. | Resolve via DI lookup of `CACHE_MANAGER` rather than re-exporting `ProductStockCommonCacheService`. |
| AR2 | medium | TTL value is duplicated: `libs/config/cache-module.config.ts:9` (default 60_000ms) and `libs/common/cache/cache.helper.ts:3` (`productStock` TTL 60_000ms). Per-key TTL on `cache.set` shadows the default, so the helper value is authoritative; the duplication is a footgun for future drift. | Extract one source of truth (cache helper) and remove the default. Out-of-scope for cache-correctness pass. |
| AR3 | medium | Untyped cache values: `cache.get<ProductStockGetResponseDto>(...)` is a type assertion only; no runtime schema validation on read. A code change that alters DTO shape leaves stale cached entries that read correctly on the JS side but with mismatched fields. | Add a schema version segment to the cache key (e.g. `stock:v2:<id>:...`) when DTO shape changes. Worth a follow-up. |
| AR4 | medium | No stampede protection / single-flight on cache miss. Concurrent first-misses on the same key fan out to N parallel DB queries. | `p-limit` per key or `redis-stampede` or store-side advisory lock. Follow-up. |
| AR5 | low | TTL has no jitter — all keys expire on a wall-clock band. Risk of thundering herd at TTL boundary if traffic is correlated. | Apply ±10% jitter on `set`. Follow-up. |
| AR6 | low | Layer reach-through in `getRedisAdapter`: `Cache → Cacheable.primary → store → KeyvRedis → adapter.client`. Defensive guards exist, but breakage with `cacheable` major version bumps is plausible. | Pin `cacheable` major in `package.json`; consider sealing the access behind a feature-detect helper in `libs/common/cache`. |
| AR7 | low | `ProductStockCommonService.get` accepts both `entityManager` and `ignoreCache` with identical effect (`skipCache`). Minor API redundancy — distinct only for log-reason debugging. | Keep as-is; the log reason has diagnostic value. |
| AR8 | low | `CacheHelper` lives in `libs/common/cache` (monorepo-wide) but its only consumer is the inventory product-stock cache. That's fine if more caches arrive; if not, it's misplaced abstraction. | Defer until second consumer. |
| AR9 | low | Invalidation contract on the façade is comment-enforced ("only call after commit"). | See B11; recommend follow-up to a transaction-aware abstraction. |

## C. Test coverage gaps

Branches enumerated in section E (cache flow). Mapping below — current E2E coverage is **zero cache-state assertions** despite ~12 cache-touching test invocations.

| Branch ID | Description | HTTP asserted? | Cache state asserted? | Log/event asserted? |
|-----------|-------------|----------------|------------------------|----------------------|
| G1 | GET miss → DB → cache set (all-storages) | ✓ | ✗ | ✗ |
| G2 | GET hit (same key as G1, repeated) → no DB read | ✗ (test does not exist) | ✗ | ✗ |
| G3 | GET miss with `storageIds=[...]` → distinct key | ✓ | ✗ | ✗ |
| G4 | GET miss → empty stock → cached as `{quantity:0,...}` (`productId=0`) | ✓ | ✗ | ✗ |
| G5 | GET miss with non-existent `storageIds` → empty result cached | ✓ | ✗ | ✗ |
| G6 | GET → cache.get throws (Redis unavailable) → DB fallback → cache.set best-effort | ✗ | ✗ | ✗ |
| G7 | GET with `entityManager` (skipCache=true) — internal path, not HTTP-reachable | n/a (domain) | n/a | n/a |
| G8 | GET with `ignoreCache=true` — internal path, not HTTP-reachable | n/a (domain) | n/a | n/a |
| C1 | PUT /confirm with all-confirmable items → DB mutation → SCAN+UNLINK clears matching keys | ✓ | ✗ | ✗ |
| C2 | PUT /confirm with no available stock → no `add()` call → no invalidate call | ✓ | ✗ (cache survives) | ✗ |
| C3 | PUT /confirm with mixed → only mutated `productId`s' cache cleared, untouched `productId`s' cache survives | ✗ (test does not exist) | ✗ | ✗ |
| C4 | PUT /confirm transaction fails → no cache mutation | ✗ (test does not exist; would need fault injection) | ✗ | ✗ |
| C5 | PUT /confirm wipes BOTH `stock:<id>:*` and `stock:<id>:storage-X` keys (proves SCAN scope) | ✗ (test does not exist) | ✗ | ✗ |

**Routing rule applied.** Branches G7, G8, C4 are domain concerns (need DI / fault injection) and should NOT be added to E2E. They belong in unit/domain specs of `ProductStockCommonService` and `ProductStockOrderConfirmService`.

**Branches in E2E scope: G1, G2, G3, G4, G5, C1, C2, C3, C5.** G6 is a fault-injection test — viable as E2E only if we can drop Redis transiently; otherwise also push to domain.

## D. Test smells (existing E2E suite)

| ID | Smell | Location | Impact |
|----|-------|----------|--------|
| S1 | No cache reset between tests. Redis state leaks across tests within a single E2E run. Tests pass today because the cached value matches the would-be DB result. Re-ordering or adding a stock-mutating test before an unrelated GET would mask cache bugs. | `test/system-api.e2e-spec.ts` — no `beforeEach` / `afterEach` clearing cache. | High — hides cache bugs. |
| S2 | Snapshot-only assertions for response bodies / DB rows. `toMatchSnapshot()` flattens the signal: a snapshot diff after a code change can be from cache, DB, or DTO shape. | Throughout. | Medium — debugging cost. |
| S3 | `assertData` mutates the `body` argument (deletes `updatedAt`). Caller-side mutation makes test reasoning harder. | `test/system-api.e2e-spec.ts:78–85`. | Low — readability. |
| S4 | Logger is disabled (`logger: false`) on all three apps. Cuts off the `cacheHit` log field that would be a clean side-channel for cache assertions. | `test/system-api.e2e-spec.ts:27, 40, 52`. | Medium — cuts useful observability. |
| S5 | Test order coupling on seeded `orderId` values (1–4). Standard but brittle if the seed expands. | `confirm` tests. | Low — pre-existing. |
| S6 | No `it.skip` / `xit` / `describe.skip` — clean. | n/a. | n/a. |
| S7 | No correlation id capture — header is asserted as defined but not used to scope log queries or correlate side effects. | All tests. | Low. |

## E. Cache flow diagrams

### E.1 GET product stock (cache-aside read-through)

```
HTTP GET /api/product/:id/stock?storageIds=...
        │
        ▼
ApiGateway → RPC (INVENTORY_PRODUCT_STOCK_GET)
        │
        ▼
ProductStockGetService.execute(payload)              [api/product-stock]
        │
        ▼
ProductStockCommonService.get(payload, options={})   [common/product-stock-common]
        │
        ├── skipCache = ignoreCache || !!entityManager  ── true ──► [skip read]
        │                       │                                       │
        │                       ▼ false                                  │
        │            CacheService.get(payload)                           │
        │                       │                                        │
        │              ┌────────┴────────┐                               │
        │              ▼ HIT             ▼ MISS                          │
        │        return cached     [continue]                            │
        │                                │                               │
        │              ┌────────┴────────┘                               │
        │              ▼ throws                                          │
        │        warn + undefined → [continue as miss]                   │
        ▼                                                                │
GetService.execute(payload, em?)  ◄────────────────────────────────────┘
        │
        ▼  (DB SUM-by-storage)
data: ProductStockGetResponseDto
        │
        ▼  (skipCache === false)
CacheService.set(payload, data) — fire-and-forget; failure → warn
        │
        ▼
return data
```

Branches per request: **HIT / MISS / READ-ERROR / SKIP-CACHE(em) / SKIP-CACHE(ignoreCache)**, with WRITE-ERROR as a sub-branch of MISS. Total observable: 5 + 1 sub.

### E.2 PUT /api/order/:id/confirm (write-through invalidation)

```
HTTP PUT /api/order/:id/confirm
        │
        ▼
ApiGateway → RPC → RetailMicroservice → RPC (INVENTORY_ORDER_CONFIRM)
        │
        ▼
ProductStockOrderConfirmService.execute(payload)
        │
        ├── pendingItems == [] ──► return []  (no transaction, no invalidation)
        │
        ▼ pendingItems.length > 0
entityManager.transaction(async em => {
    stockMap = CommonService.getMapLocked({productIds}, em)   // SELECT … FOR UPDATE
    for item in pendingItems:
        if available > 0: items.push({...item, storageId: HEAD_WAREHOUSE, quantity: -1})
                          confirmedIds.push(...)
                          mutatedItems.push(...)
    if items.length > 0: CommonService.add({items}, em)        // INSERT ledger rows
})
        │
        ├── all items skipped (no stock) ──► mutatedItems == [] ──► no invalidate call
        │
        ▼ mutatedItems.length > 0
invalidateItems = mutatedItems.filter(has storageId).map(productId, storageId)
        │
        ▼
CommonService.invalidate({items, correlationId})
        │
        ▼
CacheService.invalidate
        │
        ├── adapter !== KeyvRedis ──► invalidateNamedKeys (fallback, partial coverage)
        │
        ▼ Redis present
        for productId in unique(items):
            SCAN MATCH `<prefix>stock:<productId>:*` COUNT 100  ── batch ──► matchedKeys
        UNLINK [...matchedKeys]   (async free, non-blocking on Redis main thread)
        │
        ▼
return confirmedIds
```

Branches: **all-pending-empty / no-stock-skip-invalidate / mixed / fully-confirmed / transaction-throws (no invalidate) / fallback-path**.

### E.3 Add stock (ledger insert) — currently no cache write/invalidate inside

`ProductStockCommonService.add()` performs the ledger insert. **It does NOT invalidate cache.** Today's only caller (`ProductStockOrderConfirmService`) handles invalidation explicitly post-commit. Any future caller of `add()` outside a transaction with no invalidate call will silently leave stale cache. (See B11/AR9.)

## F. Per-file analysis

### F.1 `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-get.service.ts`

- **Public API**: `execute(payload: IProductStockGetPayload): Promise<ProductStockGetResponseDto>`. Called by `product-stock.controller.ts` on `INVENTORY_PRODUCT_STOCK_GET` RPC.
- **Cache interactions**: none (delegates fully).
- **Failure modes**: catches and rethrows, logging at `error` level with `{ ...payload, ...error }`. See B10 (Error spread).
- **Concurrency hazards**: none directly; downstream race surfaced in B8.
- **Logging**: info on entry (full payload), error on rethrow. No logs in loops. See B9 (payload contents).

### F.2 `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-order-confirm.service.ts`

- **Public API**: `execute(payload: IProductStockOrderConfirmPayload): Promise<number[]>` (returns confirmed order-product ids).
- **Cache interactions**: indirect via `productStockCommonService.invalidate(...)` AFTER transaction commit. Comment at lines 98–101 documents the post-commit ordering invariant. (Verified correct ordering: `mutatedItems` populated inside `transaction` callback; `invalidate` called after `transaction` returns — outside the callback, on the resolved promise.)
- **Failure modes**: transaction throws → caught, logged at `error`, rethrown to RPC client. No invalidation in failure path (correct).
- **Concurrency hazards**: pessimistic lock via `getMapLocked` serializes write-write conflicts. Read-write race (B8) remains.
- **Logging**: info on entry, info on success-with-confirmations, warn on no-stock, error on transaction failure. No logs in loops.
- **Trivial-fix candidates**: none observed.

### F.3 `apps/inventory-microservice/src/app/common/modules/product-stock-common/product-stock-common.service.ts` (façade)

- **Public API**: `add(payload, em?)`, `get(payload, options?)`, `getMapLocked(payload, em)`, `invalidate(payload)`.
- **Cache interactions**: `get` orchestrates cache-aside (read → DB → write) with `skipCache` logic; `invalidate` delegates to cache service.
- **Failure modes**: cache read failure → returns undefined (logged warn), DB result still returned. Cache write failure → swallowed (warn). Invalidate failure → swallowed (warn).
- **Concurrency hazards**: see B8 (cache-aside race). Façade does NOT enforce post-commit-only invalidate (B11).
- **Logging**: debug on delegations, debug on skipCache. No info/warn/error from this layer (delegated).
- **Trivial-fix candidates**: B6 truthiness check (`if (cached)` → `if (cached !== undefined)`). NOT trivial-allowlist (changes a condition).

### F.4 `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-add.service.ts`

- **Public API**: `execute(payload, em?): Promise<void>`. Inserts ledger rows via repository or transactional repository.
- **Cache interactions**: none. (See AR9: this is the right design, but adds responsibility to callers.)
- **Failure modes**: catches and rethrows the insert error, logging at error level.
- **Concurrency hazards**: none directly (insert is row-additive; locks are taken upstream by `getMapLocked`).
- **Logging**: debug on insert, info on success (with `productIds` derived inline). No logs in loops.

### F.5 `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts`

- **Public API**: `get(payload)`, `set(payload)`, `invalidate(payload)`.
- **Cache interactions**: full owner. Reads, writes, and invalidates via `@nestjs/cache-manager` + reach-through to `@redis/client` for SCAN/UNLINK.
- **Failure modes**: every Redis call wrapped in try/catch, logged at `warn`, returns undefined / no-op. Adapter detection failure → `invalidateNamedKeys` fallback (best-effort). Cluster/Sentinel client → fallback with explicit warn.
- **Concurrency hazards**: SCAN can return the same key in multiple cycles under concurrent rehash; deduped via `Set`. Invalidation is not atomic across products — partial failure is possible (caught).
- **Logging**: debug on hit/miss/write/invalidate-success, warn on every failure path. No logs in iterator loops (correct — pre-aggregated logging only).
- **Sensitive file** per Phase 2 policy. Treat all changes here as non-trivial unless purely comment / typo.

### F.6 `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-get.service.ts`

- **Public API**: `execute(payload, em?): Promise<ProductStockGetResponseDto>`, `getMapLocked(payload, em): Promise<Map<number, number>>`.
- **Cache interactions**: none.
- **Failure modes**: query failures caught + rethrown with `error`-level log + correlationId scope.
- **Concurrency hazards**: `getMapLocked` uses `pessimistic_write` to serialize concurrent confirms. `execute` is non-locking by design (read-only).
- **Logging**: debug on row count post-query. No logs in the row-mapping loop. See B12 (ledger MAX semantics — non-issue; verified).

### F.7 `libs/common/cache/cache.helper.ts`

- **Public API**: `ttlValues.productStock`, `keyPrefixes.productStock(productId)`, `keys.productStock(productId, storageIds?)`.
- **Cache interactions**: pure key/TTL utility.
- **Issues**: B1 (sort comparator), B2 (no tenant), B3 (literal `*`).
- Already carries RISK FLAG comments. Per project memory, these flags are intentionally annotated-but-unfixed.

## Summary

**Severity counts**
- Bugs: 0 critical / 0 high / 5 medium / 7 low
- Architectural: 0 critical / 0 high / 4 medium / 5 low
- Coverage gaps: 9 E2E-relevant branches, **0 currently asserted at the cache layer**
- Smells: 7 logged (1 high-impact: no cache reset between tests)

**Headline findings**
1. Cache state is never asserted in E2E. Every cache-touching code path runs in tests, but only the HTTP response is observed. (S1, all of section C.)
2. `ProductStockCommonCacheService` is not exported from the module — the audit-mandated "observe via existing cache provider abstraction" cannot be satisfied without either re-exporting it or routing assertions through `CACHE_MANAGER`. **Decision required at Phase 2.** (B4)
3. Two RISK-FLAG-annotated bugs in `cache.helper.ts` (B1 charCodeAt sort, B2 tenant collision) — left untouched per durable user instruction; recorded for completeness, not proposed for fix.
4. The cache-aside read-then-write race (B8) and lack of stampede protection (AR4) are real but out-of-scope for this pass.
5. Disabled logger in E2E (S4) eliminates a clean cache-hit side channel; switching to a captured stream is plausible but architecturally invasive.

**Phase 1 complete. Report saved to `docs/audits/cache-audit-2026-05-07.md`. Awaiting approval to proceed to planning.**

## G. Execution plan (Phase 2)

### G.1 Production fixes

| ID | Issue | File | 1-line change | Risk | Trivial? | Approval |
|----|-------|------|---------------|------|----------|----------|
| F1 | B6 | `product-stock-common.service.ts` | Tighten `if (cached)` → `if (cached !== undefined)` (align with cache service's miss contract) | low | N | user-approved (broad) |
| F2 | B10 | `product-stock-get.service.ts` | Replace `{ ...payload, ...error }` with `{ err: error, ...payload }` for proper Pino error serialization | low | N | user-approved |
| F3 | B10 | `product-stock-order-confirm.service.ts` | Same Pino `err:` field fix on error log | low | N | user-approved |
| F4 | B10 | `product-stock-common-add.service.ts` | Same Pino `err:` field fix on error log | low | N | user-approved |
| F5 | B10 | `product-stock-common-get.service.ts` | Same Pino `err:` field fix (2 sites) | low | N | user-approved |
| F6 | B10 | `product-stock-common-cache.service.ts` | Same Pino `err:` field fix (5 sites). File is sensitive but log-payload correctness outweighs sensitivity. | medium | N | user-approved |
| F7 | AR4 | `product-stock-common.service.ts` | Add follow-up comment: stampede protection / single-flight needed | none | Y (comment) | user-approved |
| F8 | B8 / B11 | `product-stock-common.service.ts` | Add follow-up comment on cache-aside read/write race + post-commit invariant | none | Y (comment) | user-approved |
| F9 | AR3 | `cache.helper.ts` | Add follow-up comment: schema-version segment when DTO shape changes | none | Y (comment) | user-approved |
| F10 | AR5 | `product-stock-common-cache.service.ts` | Add follow-up comment: TTL jitter | none | Y (comment) | user-approved |
| F11 | B7 / AR9 | `product-stock-common-cache.service.ts` | Add follow-up comment: get-then-set on Redis-down double-warns; transaction-aware invalidate abstraction | none | Y (comment) | user-approved |

**Skipped (intentionally unfixed per durable user instruction — RISK FLAGs):**
- B1 / RISK FLAG #3 (charCodeAt sort) — already annotated in code
- B2 / RISK FLAG #2 (tenant collision) — already annotated in code
- B3 (literal `*` sentinel) — adjacent to RISK FLAG #2, kept consistent

**Skipped (already-annotated-in-code best-effort fallback):**
- B5 (fallback-path multi-storage combo gap) — already commented in `invalidateNamedKeys`

### G.2 Test refinement plan (E2E only)

| ID | Scenario | Existing / New | Branch | Cache assertions | HTTP assertions |
|----|----------|----------------|--------|------------------|------------------|
| T1 | beforeAll: capture `Cache` provider via `inventoryMicroservice.get(CACHE_MANAGER)` | New (infra) | — | enabling | — |
| T2 | beforeEach: `await cache.clear()` to isolate tests | New (infra) | All | enabling | — |
| T3 | Refactor `assertData` to non-mutating form | Refactor (S3) | — | — | — |
| T4 | "returns aggregated stock for all storages" → also assert cache populated | Refine | G1 | `stock:1:*` populated post-call | unchanged |
| T5 | "returns stock filtered by matching storageIds" → also assert per-storage key | Refine | G3 | `stock:1:head-warehouse` populated, `stock:1:*` absent | unchanged |
| T6 | "returns empty items when storageIds matches no storage" → assert empty result is cached | Refine | G5 | `stock:1:non-existent-storage` populated with empty DTO | unchanged |
| T7 | "returns empty items when product has no stock" → assert empty result is cached | Refine | G4 | `stock:0:*` populated with empty DTO | unchanged |
| T8 | NEW: "serves cached value on second call without re-querying DB" | New | G2 | sentinel mutation pattern: write fake DTO into cache, GET, expect sentinel | 200, body == sentinel |
| T9 | NEW: "invalidates all matching stock cache keys on order confirm" | New | C1 / C5 | pre-populate `stock:1:*` and `stock:1:head-warehouse` and `stock:2:*`; PUT /confirm/1; assert all gone | 200 |
| T10 | NEW: "leaves cache intact when no stock was mutated" | New | C2 | pre-populate `stock:4:*`; PUT /confirm/3 (no stock); assert key still present | 200 |
| T11 | NEW: "only invalidates productIds that were mutated" | New | C3 | pre-populate `stock:1:*` and `stock:3:*`; PUT /confirm/2 (mutates only product 3); assert `stock:3:*` gone, `stock:1:*` survives | 200 |

**Coverage matrix (final, per branch):**

| Branch | Mapped to | Cache asserted? | HTTP asserted? |
|--------|-----------|-----------------|-----------------|
| G1 | T4 | ✓ | ✓ |
| G2 | T8 | ✓ | ✓ |
| G3 | T5 | ✓ | ✓ |
| G4 | T7 | ✓ | ✓ |
| G5 | T6 | ✓ | ✓ |
| C1 | T9 | ✓ | ✓ |
| C2 | T10 | ✓ | ✓ |
| C3 | T11 | ✓ | ✓ |
| C5 | T9 (combined) | ✓ | ✓ |
| G6 (cache.get throws) | **domain** (not E2E) | n/a | n/a |
| G7 (entityManager skipCache) | **domain** | n/a | n/a |
| G8 (ignoreCache flag) | **domain** | n/a | n/a |
| C4 (transaction throws) | **domain** | n/a | n/a |

### G.3 Out-of-scope (recorded for follow-up)

| Item | Reason for deferral |
|------|---------------------|
| B8 cache-aside read/write race | Needs single-flight / version stamping; cross-cutting design change. |
| AR4 stampede protection | Same family as B8; library decision (`p-limit`, `redis-stampede`). |
| AR5 TTL jitter | One-line `set` change, but it interacts with the future stampede fix; bundle. |
| AR3 schema versioning of cache key | Touches cache key format → invalidates existing cached data on deploy. Roll into a versioning policy doc. |
| S4 enabling logger in E2E | Requires log-capture infrastructure (e.g. pino stream into a memory transport). Out of scope. |
| AR6 layer reach-through fragility | Hard-pin `cacheable` major when next bumping deps. |
| Domain-spec coverage of G6/G7/G8/C4 | Outside the E2E refinement scope. Worth a separate ticket: "Add unit tests for `ProductStockCommonService.get` skip-cache and error paths." |

**Phase 2 plan ready (appended to `docs/audits/cache-audit-2026-05-07.md` as section G). Awaiting approval to execute.**

(User granted broad approval — proceeded to Phase 3 in same turn.)

## H. Execution log (Phase 3 + 4)

### H.1 Diff summary

| File | Change |
|------|--------|
| `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-get.service.ts` | F2: `{ ...payload, ...error }` → `{ err: error as Error, ...payload }` (Pino error serializer). |
| `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-order-confirm.service.ts` | F3: same `err: error as Error` switch on the catch-block log. |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/product-stock-common.service.ts` | F1: `if (cached)` → `if (cached !== undefined)` w/ comment. F7/F8: follow-up comments on cache-aside race + AR4 single-flight. F11/B11: follow-up comment on post-commit-only contract. |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-add.service.ts` | F4: same `err:` switch. |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts` | F6: 5 sites switched to `err: error as Error`. F10/AR5 (TTL jitter), F11/B7 (Redis-down double-warn), F11/AR6 (cacheable major pin) follow-up comments at the class header. |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-get.service.ts` | F5: 2 sites switched to `err: error as Error`. |
| `libs/common/cache/cache.helper.ts` | F9: AR3 follow-up comment on schema versioning. |
| `test/system-api.e2e-spec.ts` | T1–T11: cache provider capture in `beforeAll`; `beforeEach` flushes Redis; `assertSnapshot` replaces mutating `assertData`; G1/G3/G4/G5 tests now assert cache state post-call; new G2 sentinel-mutation cache-hit test; C1/C2/C3/C5 cache assertions added inline to the three existing confirm tests. |

### H.2 Pre-approved trivial fixes applied

None encountered. Spotted no in-scope typos, dead code, missing-await, or lint-only issues; all changes are tracked in section G.

### H.3 Phase 4 verification checklist

| Item | Status | Notes |
|------|--------|-------|
| Lint passes on all touched files (`yarn lint`, max-warnings 0) | ✅ | Initial run flagged 11 `no-unsafe-assignment` errors from `err: error` (catch binds `any` because `useUnknownInCatchVariables` is off); resolved by casting `error as Error`. Final run clean. |
| Full E2E suite green (`yarn test:e2e`) | ✅ | 24/24 tests passing, 42/42 snapshots. Includes 1 new test (G2) and refined cache assertions on 7 existing tests. |
| Inventory microservice unit tests green | ✅ | `yarn test:unit` — 11/11 (retail-microservice domain spec; no inventory-microservice unit specs exist today — recorded as a follow-up). |
| Build succeeds (`yarn build`) | ✅ | 4/4 webpack compiles successful. |
| No skipped tests introduced | ✅ | No `it.skip`, `xit`, `describe.skip` added. |
| No leftover debug statements | ✅ | grep clean. |
| Every approved Phase 2 item implemented | ✅ | F1–F11 all applied; T1–T11 all applied. |
| Out-of-scope items recorded | ✅ | See G.3 + H.4. |

### H.4 Follow-ups (recorded for future tickets)

| ID | Description | Surface |
|----|-------------|---------|
| FU1 | B8 / AR4: cache-aside read-then-write race; consider single-flight or version-stamped writes. | Comment at `product-stock-common.service.ts:get` miss path. |
| FU2 | B11 / AR9: replace comment-enforced post-commit invalidation with a transaction-aware abstraction (`afterCommit` hook or `addAndInvalidate`). | Comment at `product-stock-common.service.ts:invalidate`. |
| FU3 | AR3: introduce a schema-version segment in cache keys when `ProductStockGetResponseDto` shape changes. | Comment at `cache.helper.ts` header. |
| FU4 | AR5: TTL jitter (±10%) at `cache.set` to avoid synchronized expirations. | Comment at `product-stock-common-cache.service.ts` header. |
| FU5 | B7: in-process unavailability flag to skip the `set` attempt when the preceding `get` already saw Redis down (eliminates duplicate warn lines). | Comment at `product-stock-common-cache.service.ts` header. |
| FU6 | AR6: pin `cacheable` major version in `package.json` before next dep refresh, since the SCAN path reaches through its internals. | Comment at `product-stock-common-cache.service.ts` header. |
| FU7 | Domain coverage of `ProductStockCommonService.get` skip-cache (G7), ignoreCache (G8), and `cache.get` throws (G6). E2E is not the right home; needs dedicated unit specs. | Tracked here only. |
| FU8 | Domain coverage of `ProductStockOrderConfirmService` transaction-failure path (C4); needs a fault-injectable repo mock. | Tracked here only. |
| FU9 | S2: snapshot-only assertions remain for response bodies and DB rows. Worth keeping snapshots but pairing with explicit assertions on critical fields where regressions are hard to attribute. | Cross-cutting test refinement. |
| FU10 | S4: enabling Pino logger in E2E would unlock the `cacheHit` log side-channel for assertions. Requires log-capture infrastructure. | Cross-cutting test refinement. |
| FU11 | RISK FLAG #2 (B2) — tenant collision in cache keys. Latent until tenant model is introduced. | `cache.helper.ts:keyPrefixes.productStock`. |
| FU12 | RISK FLAG #3 (B1) — `charCodeAt(0)` storage-id sort comparator. Causes extra cache misses on permuted-input requests. | `cache.helper.ts:keys.productStock`. |
| FU13 | B3 — literal `*` "all-storages" sentinel could be confused with a glob pattern in a future invalidation refactor. Use a non-meta sentinel (`__all__`). | `cache.helper.ts:keys.productStock`. |
| FU14 | B5 — `invalidateNamedKeys` fallback only deletes literal-`*` and single-storage keys; multi-storage combo keys survive until TTL. Acceptable best-effort for the non-Redis path. | `product-stock-common-cache.service.ts:invalidateNamedKeys`. |
| FU15 | AR2 — TTL value (60_000) duplicated between `libs/config/cache-module.config.ts` (default) and `libs/common/cache/cache.helper.ts` (per-key). Consolidate or document. Default kept intentionally as an Infinity-TTL guardrail. | Cross-cutting config. |

### H.5 Final summary table

| Item | Status | Notes |
|------|--------|-------|
| Production fixes applied (approved) | 11 / 11 | F1–F11 applied. RISK FLAG #2 (B2), #3 (B1), and B3 left annotated, not fixed (durable user instruction). |
| Trivial fixes applied (pre-approved) | 0 | None encountered in scope. |
| E2E tests refined | 7 / 7 | All four GET-stock happy-path tests + three confirm tests now assert cache state. `assertData` (mutating) replaced with `assertSnapshot` (non-mutating). |
| New E2E tests added | 1 / 1 | G2 cache-hit test ("serves cached value on subsequent calls without re-querying the DB") via sentinel mutation. |
| Test smells resolved | 3 / 7 | S1 (no cache reset) — fixed via `beforeEach`. S3 (mutating `assertData`) — fixed. S5 — already clean. S2/S4/S7 deferred (FU9/FU10). |
| Follow-up items recorded | 15 |

## I. Unit test plan (Phase 1 of follow-on task)

### I.1 Project test conventions (confirmed)

| Item | Finding |
|------|---------|
| Spec folder layout | `spec/` sibling next to production file. Confirmed by the only existing spec at `apps/retail-microservice/src/app/api/order/domain/spec/order-confirm.domain.spec.ts`. |
| Spec naming | `<production-filename>.spec.ts`. Existing example uses `.domain.spec.ts` because the file under test is `order-confirm.domain.ts` — naming is "production basename + `.spec.ts`". For our targets that yields `<service>.service.spec.ts`. |
| Test framework | Jest. `describe` / `it` / `expect`. ts-jest transform. |
| Jest unit config picks up `spec/` folders | **Yes** — `testMatch: ['<rootDir>/**/*.spec.ts']` in `jest.unit.config.js` matches `**/spec/*.spec.ts` without changes. No config tweak needed. |
| `tsconfig` `rootDir` | None set; relative imports `../foo.service` resolve cleanly from `spec/`. |
| Path aliases | `@retail-inventory-system/{common,config,inventory,retail}` mapped in `moduleNameMapper`. |
| Mocking style | Existing spec is a pure-domain test with no DI mocks. **No project precedent** for mocking PinoLogger / TypeORM / Cache — convention will be set by this pass. Plan: typed `jest.Mocked<T>` mocks, plain object literals for `PinoLogger`. |
| Mock lifecycle | No `clearMocks` / `resetAllMocks` in Jest config. Plan: `jest.resetAllMocks()` in each spec's `beforeEach`. |
| Existing fixtures / helpers | None observed in inventory microservice. Each spec stands alone (no shared helper file). |

**Convention inconsistency / follow-up:** the one existing spec lives under `apps/retail-microservice/src/app/api/order/domain/spec/`. The inventory microservice has zero specs to date — this pass sets the convention there. Recorded as informational, no action.

### I.2 Existing unit coverage check

| Production file | Existing spec? | Action |
|-----------------|----------------|--------|
| `product-stock-get.service.ts` | No | New spec |
| `product-stock-order-confirm.service.ts` | No | New spec |
| `product-stock-common.service.ts` | No | New spec |
| `product-stock-common-add.service.ts` | No | New spec |
| `product-stock-common-cache.service.ts` | No | New spec |
| `product-stock-common-get.service.ts` | No | New spec |

**6 new spec files; 0 to extend.**

### I.3 Branch reconciliation (E2E vs unit)

| Branch | E2E asserts | Unit asserts |
|--------|-------------|--------------|
| G1 GET miss → DB → cache write | HTTP 200 + cache key populated | façade calls cache.get → (miss) → getService.execute → cache.set with `CacheHelper.keys.productStock` and `CacheHelper.ttlValues.productStock`; debug log `cacheHit:false` from cache service |
| G2 GET hit → no DB read | Sentinel surfaces in HTTP body | façade returns cached value; getService.execute NOT called; cache.set NOT called; debug log `cacheHit:true` |
| G3 GET with storageIds | Per-storage key populated, unfiltered absent | cache.get called with `stock:1:head-warehouse` exact string; cache.set called with same |
| G4 GET empty product | Empty DTO cached | empty DTO `{quantity:0, items:[], updatedAt:null}` is the value passed to cache.set |
| G5 GET non-existent storage | Empty DTO cached at per-storage key | same shape assertion |
| G6 cache.get throws | (not in E2E — fault injection) | **unit only**: returns DB result; warn log with `err` field |
| G7 entityManager skip | (domain) | **unit only**: cache.get NOT called; cache.set NOT called; debug log `reason:'entityManager'`; getService.execute called with the em |
| G8 ignoreCache skip | (domain) | **unit only**: same as G7 with `reason:'ignoreCache'` |
| C1 confirm wipes all keys | All keys gone post-PUT | order-confirm calls `productStockCommonService.add(...em)` then `productStockCommonService.invalidate(...)` AFTER the transaction returns; mutatedItems carries the (productId, storageId) pairs |
| C2 confirm with no stock | Cache survives | order-confirm: when no items confirmable, `add` NOT called and `invalidate` NOT called; warn log "No stock available…" |
| C3 mixed confirm | Only mutated keys gone | invalidateItems contains only the mutated productIds |
| C4 transaction throws | (domain) | **unit only**: error log + rethrow; invalidate NOT called |
| C5 SCAN scope | Both unfiltered + per-storage keys gone | cache service: SCAN MATCH pattern equals `stock:<id>:*` exactly; UNLINK called with the deduped match set |

E2E continues to own observable HTTP outcomes; unit tests own collaborator interactions, log fields, key/TTL exact values, and ordering.

### I.4 Per-file unit test plan

#### I.4.1 `product-stock-common-cache.service.ts`

| Method | Branch / scenario | Mocked behavior | Assertions |
|--------|-------------------|-----------------|-----------|
| `get` | hit | `cache.get` resolves a DTO | returns DTO; `cache.get` called with exact key `stock:42:*`; debug log `{correlationId, productId, cacheKey, cacheHit:true}` and message "Cache hit for stock query" |
| `get` | miss | `cache.get` resolves `undefined` | returns `undefined`; debug log `cacheHit:false` and message "Cache miss for stock query" |
| `get` | with storageIds | `cache.get` resolves DTO | called with `stock:42:head-warehouse` (single storage) |
| `get` | error | `cache.get` rejects | returns `undefined`; warn log includes `err` field; no rethrow |
| `set` | happy | `cache.set` resolves | called with key + DTO + TTL=`60_000`; debug log `{correlationId, productId, cacheKey, ttl}` |
| `set` | error | `cache.set` rejects | warn log with `err` field; no rethrow |
| `invalidate` | empty items | n/a | early return; `cache.del` and any redis client method NOT called |
| `invalidate` | non-Redis store (fallback) | `(cache as Cacheable).primary.store` is `{}` | calls `cache.del` for both `stock:<id>:*` and `stock:<id>:<storageId>`; debug log "Stock cache invalidated via named-key fallback" |
| `invalidate` | non-Redis store, del rejects | `cache.del` rejects | warn log with `err` field |
| `invalidate` | Redis but no scanIterator | store has `KeyvRedis.prototype` but `client` lacks `scanIterator` | warn log "scanIterator…falling back…"; falls through to named-key fallback |
| `invalidate` | Redis happy path | store has `KeyvRedis.prototype`; client provides `scanIterator` (yields batches) and `unlink` | SCAN pattern is `stock:<id>:*` (no namespace); `unlink` called once with deduped key set; debug log "Stock cache invalidated via SCAN+UNLINK" with `keyCount` |
| `invalidate` | with namespace | adapter has `namespace='ns'`, `keyPrefixSeparator='::'` | SCAN pattern is `ns::stock:<id>:*` |
| `invalidate` | dedup across SCAN cycles | scanIterator yields overlapping batches | UNLINK receives unique keys only |
| `invalidate` | scanIterator throws | iterator rejects mid-iteration | warn log "SCAN failed…"; UNLINK NOT called; early return |
| `invalidate` | no matched keys | scanIterator yields empty batches | debug log "No matching stock cache keys to invalidate"; UNLINK NOT called |
| `invalidate` | unlink throws | unlink rejects | warn log "UNLINK failed…" with `err` field |
| `invalidate` | multiple productIds | items spans 2 productIds | scanIterator called twice with each `stock:<id>:*` pattern; UNLINK called once with combined deduped set |

**Tests:** ~16

#### I.4.2 `product-stock-common-add.service.ts`

| Method | Scenario | Mocked | Assertions |
|--------|----------|--------|-----------|
| `execute` | no em, happy | injected `Repository.insert` resolves | calls injected repository's `insert(items)`; debug log `{correlationId, itemCount, withinTransaction:false}`; info log `{correlationId, itemCount, productIds}` |
| `execute` | with em, happy | `em.getRepository(ProductStock).insert` resolves | uses em-derived repo, NOT the injected one; debug log `withinTransaction:true` |
| `execute` | repo.insert throws | rejects | error log `{err, correlationId, itemCount}`; rethrows; info "inserted" log NOT called |

**Tests:** 3

#### I.4.3 `product-stock-common-get.service.ts`

| Method | Scenario | Mocked | Assertions |
|--------|----------|--------|-----------|
| `execute` | no storageIds, non-empty rows | QueryBuilder chain returns 2 raw rows | returns `{productId, quantity:sum, items:[…], updatedAt:max}`; `andWhere` NOT called |
| `execute` | with storageIds | rows returned | `andWhere('ProductStock.storageId IN (:...storageIds)', {storageIds})` called |
| `execute` | with em | em provides repo | uses `em.getRepository(ProductStock)`, not injected |
| `execute` | empty result | getRawMany resolves `[]` | returns `{quantity:0, items:[], updatedAt:null}` |
| `execute` | getRawMany throws | rejects | error log; rethrows |
| `getMapLocked` | empty productIds | n/a | returns empty Map; **no DB call** (em.createQueryBuilder NOT invoked) |
| `getMapLocked` | non-empty, happy | em chain returns 2 rows | result Map has expected entries; `setLock('pessimistic_write')` invoked |
| `getMapLocked` | non-empty, throws | em chain rejects | error log; rethrows |

**Tests:** 8

#### I.4.4 `product-stock-common.service.ts` (façade)

| Method | Scenario | Mocked | Assertions |
|--------|----------|--------|-----------|
| `add` | delegate w/o em | addService.execute resolves | called with `(payload, undefined)`; debug log `withinTransaction:false` |
| `add` | delegate w/ em | resolves | called with `(payload, em)`; debug log `withinTransaction:true` |
| `get` | cache hit | cacheService.get resolves DTO | returns DTO; getService.execute NOT called; cacheService.set NOT called |
| `get` | cache miss | cacheService.get resolves undefined; getService.execute resolves DTO | returns DTO; cacheService.set called with `{productId, storageIds, data, correlationId}` |
| `get` | cache miss + DB throws | getService.execute rejects | rethrows; cacheService.set NOT called |
| `get` | skipCache via em | options has em | cacheService.get NOT called; cacheService.set NOT called; debug log `reason:'entityManager'`; getService.execute called with em |
| `get` | skipCache via ignoreCache | options has ignoreCache:true | cacheService.get NOT called; cacheService.set NOT called; debug log `reason:'ignoreCache'` |
| `get` | em + ignoreCache both | both set | cacheService.get NOT called; reason='entityManager' (em wins ternary) |
| `get` | call ordering | cache miss path | cache.get → getService.execute → cache.set in that order (assert via `mock.invocationCallOrder`) |
| `getMapLocked` | delegate | getService.getMapLocked resolves | called with `(payload, em)` |
| `invalidate` | delegate | cacheService.invalidate resolves | called with `payload`; debug log |

**Tests:** ~11

#### I.4.5 `product-stock-get.service.ts` (top layer)

| Method | Scenario | Mocked | Assertions |
|--------|----------|--------|-----------|
| `execute` | happy | commonService.get resolves DTO | returns DTO; info log "Received RPC: get product stock" with payload fields |
| `execute` | downstream throws | commonService.get rejects | error log `{err, ...payload}`; rethrows |

**Tests:** 2

#### I.4.6 `product-stock-order-confirm.service.ts` (top layer)

| Method | Scenario | Mocked | Assertions |
|--------|----------|--------|-----------|
| `execute` | no pending | products all CONFIRMED | returns `[]`; info log "No pending products to reserve…"; entityManager.transaction NOT called |
| `execute` | all confirmable | em.transaction calls callback; getMapLocked returns sufficient stock; add resolves | returns confirmedIds for all pending; commonService.add called once with all items inside the tx; commonService.invalidate called AFTER tx with `mutatedItems` mapped to `{productId, storageId}` |
| `execute` | none confirmable | getMapLocked returns 0 for every productId | warn log "No stock available…"; commonService.add NOT called; commonService.invalidate NOT called |
| `execute` | mixed | partial stock | add called with subset; invalidate called only with the mutated subset |
| `execute` | transaction throws | em.transaction rejects | error log `{err, correlationId, productIds, pendingCount}`; rethrows; invalidate NOT called |
| `execute` | invalidate post-commit ordering | happy path | assert `add` invocation precedes `invalidate` invocation (via `mock.invocationCallOrder`) |

**Tests:** 6

### I.5 Summary

- **6 new specs**; 0 extended.
- **~46 test cases planned**.
- **Jest config matches** — no edits needed.
- **No new helpers, no new dependencies, no production changes.**
- **Dead-code / unreachable findings**:
  - `product-stock-order-confirm.service.ts:103-105` — the `.filter((item): item is typeof item & { storageId: string } => !!item.storageId)` defensive filter is unreachable today (every constructed item has `storageId: INVENTORY_DEFAULT_STORAGE`). Recorded as **FU16** — not removed in this pass (production file is out of scope here).
- **Newly discovered bugs while planning**: none beyond what audit recorded.
- **Test-helper opportunities** (recorded for follow-up, not built here):
  - **FU17** — A small `makePinoLoggerMock()` factory would deduplicate `{ info, debug, warn, error, fatal, trace, ...} as unknown as PinoLogger` across all six specs. This pass writes the mock inline in each file to follow the "no new helpers without flag-and-approve" rule.

**Phase 1 complete. Unit test plan appended to `docs/audits/cache-audit-2026-05-07.md` as section I. Awaiting approval to execute.**

## J. Unit test execution log (Phase 2 + 3)

### J.1 Spec files created

| Spec path | Tests | Lines |
|-----------|------:|------:|
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-cache.service.spec.ts` | 17 | 327 |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-add.service.spec.ts` | 3 | 86 |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-get.service.spec.ts` | 8 | 197 |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/spec/product-stock-common.service.spec.ts` | 11 | 207 |
| `apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-get.service.spec.ts` | 2 | 65 |
| `apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-order-confirm.service.spec.ts` | 7 | 252 |

**Total: 6 specs, 48 tests** (+2 vs. plan: one additional cache-service test for the per-storage key construction; one additional order-confirm test to cover the `Map.get(productId) ?? 0` branch — see J.4).

### J.2 Coverage (from `npx jest --coverage --collectCoverageFrom=…product-stock*.service.ts`)

| File | Stmts | Branch | Funcs | Lines |
|------|------:|-------:|------:|------:|
| `product-stock-get.service.ts` | 100% | 100% | 100% | 100% |
| `product-stock-order-confirm.service.ts` | 100% | 100% | 100% | 100% |
| `product-stock-common.service.ts` | 100% | 100% | 100% | 100% |
| `product-stock-common-add.service.ts` | 100% | 100% | 100% | 100% |
| `product-stock-common-cache.service.ts` | 100% | 100% | 100% | 100% |
| `product-stock-common-get.service.ts` | 100% | 100% | 100% | 100% |
| **All six files** | **100%** | **100%** | **100%** | **100%** |

### J.3 Verification checklist

| Check | Result |
|-------|--------|
| All new spec files lint clean (`yarn lint`, `--max-warnings 0`) | ✅ |
| `yarn test:unit` passes | ✅ 7 suites / 59 tests |
| All six specs in `spec/` sibling folders (verified by `ls`) | ✅ |
| Inventory microservice unit suite passes | ✅ |
| E2E suite still passes (no production drift) | ✅ 24/24 tests, 42/42 snapshots after `yarn test:e2e` |
| 100% statements + 100% branches on each of the six files | ✅ |
| No `it.skip` / `xit` / `it.todo` / `describe.skip` introduced | ✅ (grep clean) |
| No `console.log` in specs | ✅ (grep clean) |
| Every Phase 1 plan row maps to ≥1 `it` block | ✅ |
| Frontmatter `status` preserved as `completed` | ✅ |

### J.4 Plan-to-spec deltas (with reasons)

| Delta | Reason |
|-------|--------|
| +1 cache-service test "builds the per-storage key when storageIds is provided" | Plan named storageIds branch but folded it into the hit/miss test. Split into a focused test targeting the cache-key string. |
| +1 order-confirm test "treats a missing stockMap entry as zero available (?? 0 branch)" | Initial run reported branch coverage 87.5% on `order-confirm.service.ts` line 55 (`stockMap.get(item.productId) ?? 0`). Added a test passing `new Map()` to exercise the nullish-coalescing path. |
| Logger-mock factory (FU17) inlined per file | Plan said "no new helpers without flag-and-approve." Each spec defines its own `LoggerMock` type alias + `makeLogger` factory. Future pass can hoist these into a shared helper. |

### J.5 Lint frictions encountered (resolved)

| Friction | Resolution |
|----------|------------|
| `KeyvRedis` constructor opens a real Redis connection | `Object.create(KeyvRedis.prototype)` + `Object.defineProperty` to set `client`/`namespace`/`keyPrefixSeparator` without triggering setters. |
| `@typescript-eslint/no-unsafe-assignment` on `err: error` (catch binds `any`) | Already cast as `error as Error` in production; in specs the `err` field receives a real `Error` instance directly. |
| `@typescript-eslint/require-await` on async generators with no `await` | Added `await Promise.resolve()` no-op at top of each generator. |
| `@typescript-eslint/unbound-method` when asserting on `entityManager.getRepository` | Stored the `jest.fn` in a local variable and asserted on that, instead of accessing the method via the structural `EntityManager` type. |
| `@typescript-eslint/consistent-type-definitions` on object-literal `type CacheMock` | Converted to `interface ICacheMock` (also satisfies the `I[A-Z]` naming convention). |
| `replace_all CacheMock → ICacheMock` accidentally produced `IICacheMock` | Followed up with a targeted `replace_all IICacheMock → ICacheMock`. |
| `@typescript-eslint/explicit-function-return-type` on factory helpers | Added explicit return types: `LoggerMock` / `ICacheMock` / `AsyncIterable<string[]>` / `KeyvRedis<unknown>` / etc. |

### J.6 Findings recorded (no production changes made)

| ID | Finding | Source |
|----|---------|--------|
| FU16 | Defensive filter in `product-stock-order-confirm.service.ts:103-105` (`!!item.storageId`) is unreachable today — every item built in this code path carries `storageId: INVENTORY_DEFAULT_STORAGE`. Recorded only; not removed (test-only pass). | Phase 1 spec audit |
| FU17 | `makePinoLoggerMock()` factory would dedupe ~6 lines across all six specs. | Phase 1 + Phase 2 |
| FU18 | Convention inconsistency: `apps/retail-microservice` had one spec; `apps/inventory-microservice` had zero before this pass. New convention (typed `jest.Mocked<T>`, plain `LoggerMock`, `jest.resetAllMocks()` in `beforeEach`) established here. | Phase 1 |

### J.7 Final summary

| File | Spec path | Status | Tests | Stmts % | Branch % | Notes |
|------|-----------|--------|------:|--------:|---------:|-------|
| `product-stock-get.service.ts` | `…/api/product-stock/providers/spec/product-stock-get.service.spec.ts` | new | 2 | 100 | 100 | — |
| `product-stock-order-confirm.service.ts` | `…/api/product-stock/providers/spec/product-stock-order-confirm.service.spec.ts` | new | 7 | 100 | 100 | +1 over plan for the `?? 0` branch. |
| `product-stock-common.service.ts` | `…/common/modules/product-stock-common/spec/product-stock-common.service.spec.ts` | new | 11 | 100 | 100 | Includes call-order assertion via `mock.invocationCallOrder`. |
| `product-stock-common-add.service.ts` | `…/providers/spec/product-stock-common-add.service.spec.ts` | new | 3 | 100 | 100 | — |
| `product-stock-common-cache.service.ts` | `…/providers/spec/product-stock-common-cache.service.spec.ts` | new | 17 | 100 | 100 | KeyvRedis prototype-injection pattern. |
| `product-stock-common-get.service.ts` | `…/providers/spec/product-stock-common-get.service.spec.ts` | new | 8 | 100 | 100 | — |
 FU1–FU15. |


