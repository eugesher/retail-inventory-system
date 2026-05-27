---
epic: epic-00
task_number: 2
title: Add ADR-002 supersession pointer for the cache-aside evolution chain (ADR-006/016/021/022/023)
depends_on: []
doc_deliverable: null
---

# Task 02 — Add an ADR-002 supersession pointer for the cache-aside evolution chain

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. In particular, read ADR-002, ADR-003, ADR-006, ADR-016, ADR-021, ADR-022, ADR-023 in full before deciding the wording of the pointer.

## ADR audited

[ADR-002 — Use Redis Cache-Aside for Product Stock Queries](../../../docs/adr/002-redis-cache-aside-product-stock.md). Accepted (2026-05-08).

## Discrepancy

ADR-002's `## Decision` block cites several implementation specifics that no longer exist verbatim in the code:

| ADR-002 claim                                                  | Actual state today                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cache lives in `ProductStockCommonService` façade              | Lives behind `IStockCachePort` (`apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`) |
| Key format `stock:<productId>:<sorted-storageIds-joined>` and `stock:<productId>:*` | Key format `ris:[t:<tenantId>:]inventory:stock:v1:<productId>[:<facet>]` — ADR-016 + ADR-022 |
| `CacheHelper.keys.productStock` in `libs/common/cache/cache.helper.ts` | `CACHE_KEYS.inventoryStock(...)` in `libs/cache/cache-keys.ts`                              |
| TTL env vars `CACHE_TTL_MS_DEFAULT` / `CACHE_TTL_MS_PRODUCT_STOCK` (60000 ms) | TTL still env-driven; **plus** ±10 % jitter on the StockCache write path (ADR-021)        |
| Invalidation is fire-and-forget (`SCAN MATCH stock:<productId>:*` then `UNLINK`) | Invalidation is **awaited** post-commit, type-enforced via `IStockCachePort.withInvalidation(work, resolveItems, opts)` (ADR-016 + ADR-023). Reaches Redis via `ICachePort.delByPrefix(prefix)` in `libs/cache/redis-cache.adapter.ts:122`. Three legacy prefixes are still wiped during the transition window (ADR-022 §"transition") |
| `@nestjs/cache-manager` / `@keyv/redis` reached through directly inside the service | Application code may not import `@nestjs/cache-manager`/`@keyv/redis` at all (ADR-016 binding rule); only `libs/cache/redis-cache.adapter.ts` does |

The core *decision* (cache-aside lazy-load + post-commit invalidate as the freshness primitive) still holds — it just lives behind a different abstraction shape, with stronger guarantees on invalidate ordering. ADR-002's Status is still `Accepted` with no supersession pointer; the existing `## References` block lists ADR-006 and ADR-016 but omits ADR-021/022/023.

Surface: `docs/adr/002-redis-cache-aside-product-stock.md` (the ADR prose itself).

## Evidence

ADR-002 prose still cites the original shape:

```text
docs/adr/002-redis-cache-aside-product-stock.md:22:The cache lives in a shared `ProductStockCommonService` façade in the Inventory microservice.
docs/adr/002-redis-cache-aside-product-stock.md:31:**Cache key format** (`CacheHelper.keys.productStock` in `libs/common/cache/cache.helper.ts`):
docs/adr/002-redis-cache-aside-product-stock.md:34:stock:<productId>:<sorted-storageIds-joined-by-comma>
docs/adr/002-redis-cache-aside-product-stock.md:40:**Invalidation** runs in `ProductStockOrderConfirmService` after the order-confirm transaction commits. It is fire-and-forget — the RPC reply is not blocked on cache work.
```

Real cache-port surface:

```text
apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts  # the IStockCachePort adapter
libs/cache/cache-keys.ts                                                            # CACHE_KEYS.inventoryStock(...)
libs/cache/redis-cache.adapter.ts:122                                               # ICachePort.delByPrefix
```

Awaited-and-type-enforced post-commit ordering verified by reading the IStockCachePort surface — there is no public `invalidate(...)` method; the only entry point is `withInvalidation(work, resolveItems, opts)` (ADR-023).

ADR-002's References section already lists ADR-006 and ADR-016 but does not mention ADR-021/022/023.

## Why this matters

ADR-002 is the only ADR that documents the *original* cache-aside contract for product stock. A new contributor reading ADR-002 in isolation will encounter:

1. A class (`ProductStockCommonService`) that does not exist — they will `grep` and find nothing.
2. A key format (`stock:<productId>:*`) that, if implemented, will be invisible to the post-commit `delByPrefix` calls (which scan `ris:inventory:stock:v1:<productId>:*`). Cache entries written with the old key shape would never be invalidated — a real correctness issue.
3. A fire-and-forget invalidate model that — if re-implemented — silently regresses ADR-023's type-enforced ordering guarantee. Pre-commit invalidate is exactly the failure mode ADR-002 itself rejected on line 42.

So the gap between ADR-002 prose and live code is not cosmetic — a fresh implementer following ADR-002 literally would write code that bypasses the current safety rails.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-002 with a one-line supersession pointer and extend `## References` (recommended).**

ADR-003 line 62 permits "flipping its `Status` and adding a one-line pointer." Use that allowance:

- Replace `**Status**: Accepted` with `**Status**: Accepted (mechanism superseded in part by ADR-006 → ADR-023; see References for the chain)`.
- Extend the existing `## References` section with the missing chain entries:
  - `[ADR-021](021-cache-single-flight-and-ttl-jitter.md)` — adds the in-process `singleFlight(key, fn)` miss-dedupe primitive and ±10 % TTL jitter on writes. The "cache-aside race" trade-off ADR-002 §Negative listed as `CACHE-001` is closed here.
  - `[ADR-022](022-cache-keys-tenant-and-schema-version.md)` — moves key shape to `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`. The `stock:<productId>:*` literal in this ADR's §Decision is now `ris:inventory:stock:v1:<productId>:*` (and is reachable only via `CACHE_KEYS.inventoryStock(...)`). The DTO-shape trade-off ADR-002 §Negative listed as `CACHE-003` is closed here.
  - `[ADR-023](023-cache-invalidate-post-commit-by-type.md)` — replaces fire-and-forget invalidate with a type-enforced post-commit `withInvalidation(...)` helper. ADR-002's "fire-and-forget" wording is now historical.

Do **not** rewrite the body of ADR-002's Decision / Consequences sections. The body stands as the historical record; the supersession pointer + extended References redirect the reader.

**Option B — Write a new ADR-024 "Cache-aside for product stock: current mechanism summary" that supersedes ADR-002 outright.**

Allocates ADR-024 to a freshly-written re-statement of the current mechanism, with ADR-002 Status flipped to `Superseded by ADR-024`. The advantage is that ADR-024 reads cleanly without a forward-reference graph. The cost is one extra ADR file to maintain and the slight historical inversion (ADR-006/016/021/022/023 chained from ADR-002 incrementally; ADR-024 would document the *result* of that chain). Weaker than option A given the chain already exists.

## Scope

**In:**

- Edit `docs/adr/002-redis-cache-aside-product-stock.md` Status line + extend `## References` (option A), or
- Allocate ADR-024 + author it as a re-statement of the current mechanism (option B).

**Out:**

- Any change to cache code under `libs/cache/` or `apps/inventory-microservice/src/modules/stock/infrastructure/cache/`.
- Any change to ADR-001 (filed separately under epic-00 task-01) or to ADR-003.
- Any rewrite of ADR-002's `## Decision` body.

## Exit criteria

- [ ] A reader landing on ADR-002 sees an explicit signal that the cited class names / key format / fire-and-forget mechanism are historical, and a complete forward-reference chain through ADR-006 → ADR-023.
- [ ] `yarn lint` still passes (touching only `docs/adr/*.md` should be a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-002 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
