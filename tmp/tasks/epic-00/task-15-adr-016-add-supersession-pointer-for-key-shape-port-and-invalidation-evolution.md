---
epic: epic-00
task_number: 15
title: Add ADR-016 supersession pointer for the key-shape, port-surface and invalidation evolution chain (ADR-021/022/023)
depends_on: []
doc_deliverable: null
---

# Task 15 — Add an ADR-016 supersession pointer for the key-shape, port-surface, and invalidation evolution

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. In particular, read ADR-016, ADR-003, ADR-021, ADR-022, ADR-023 in full before deciding the wording of the pointer. CLAUDE.md §"Shared Libraries" → `@retail-inventory-system/cache` paragraph and §"Operational notes" → "Redis cache-aside is generalized" bullet are the live authorities on what is closed today.

## ADR audited

[ADR-016 — Generalized cache-aside: `ris:<service>:<aggregate>:<id>` keys + port-based invalidation](../../../docs/adr/016-cache-aside-generalized.md). Accepted (2026-05-14).

## Discrepancy

ADR-016 §Decision (lines 20-52) and §"Still open" (lines 61-70) describe the `libs/cache` surface as it stood at task-11. Three later ADRs have evolved every load-bearing fact in that surface — key shape, the invalidation seam, the port methods, and the entire open-trade-offs register — without ADR-016's Status / References being amended. ADR-016 has no `## References` section at all, so a reader landing on it cold has no forward graph to ADR-021/022/023.

| ADR-016 claim                                                                                                                | Actual state today                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 Key convention — `ris:<service>:<aggregate>:<id>[:<facet>]`                                                               | Live shape is `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]` per ADR-022 — `libs/cache/cache-keys.ts:48-70` (version segment + opt-in tenant segment baked into every builder)                                                              |
| §2 — Apps invalidate via `CACHE_KEYS.<aggregate>Prefix(...)` + `port.delByPrefix(...)`; `StockCache` exposes `invalidate({items, correlationId})` | Live `IStockCachePort` has **no public `invalidate(...)`** — `application/ports/stock-cache.port.ts:43-57` enforces a single seam `withInvalidation(work, resolveItems, opts)`. The use case at `application/use-cases/reserve-stock-for-order.use-case.ts:65` is the only call-site. (ADR-023.) |
| §2 — `delByPrefix` called "once for the new prefix and once for the legacy `stock:` prefix"                                  | Live `invalidatePrefixes` issues **three** calls per productId during the ADR-022 transition window: v1 (`inventoryStockPrefix`), pre-v1 post-ADR-016 (`inventoryStockLegacyPrefix`), pre-ADR-016 (`productStockPrefix`) — `stock.cache.ts:147-153`              |
| §3 — Awaited invalidation post-commit "does NOT close CACHE-001 (read/write race / no single-flight)"                        | CACHE-001 is closed by ADR-021 (in-process `singleFlight` shared loader) and CACHE-004 by the same ADR's ±10% TTL jitter on the StockCache write path                                                                                                            |
| §"Still open" register (CACHE-001 read/write race, CACHE-002 post-commit contract by comment, CACHE-003 no schema-version, CACHE-004 no TTL jitter, CACHE-005 dup warn logs on Redis-down, CACHE-009 no tenant) | All six closed. CACHE-001/004 → ADR-021. CACHE-002 → ADR-023 (post-commit ordering type-enforced via `IStockCachePort.withInvalidation`). CACHE-003/009 → ADR-022. CACHE-005 → `IStockCachePort.get` returns `{value, available}` so `getOrLoad` skips write-back when Redis is down (one warn per request, not three) — see CLAUDE.md §"Operational notes" |

The core *decision* (generalize the cache layer so apps depend only on `libs/cache`; centralize keys in `CACHE_KEYS`; add `delByPrefix` to the port; close the three audit items the ADR enumerates as in-scope) still holds — that is exactly what the three downstream ADRs build on. It is the *snapshot of the surface* and the *still-open register* that are stale.

Surface: `docs/adr/016-cache-aside-generalized.md` (the ADR prose itself).

## Evidence

ADR-016 prose still cites the original surface:

```text
docs/adr/016-cache-aside-generalized.md:22:Every new cache key follows `ris:<service>:<aggregate>:<id>[:<facet>]`.
docs/adr/016-cache-aside-generalized.md:34:Apps invalidate via `CACHE_KEYS.<aggregate>Prefix(...)` + `port.delByPrefix(...)`. The stock adapter (`StockCache` in the inventory microservice) wraps the port and exposes a domain-shaped `invalidate({ items, correlationId })` that fans `delByPrefix` per unique productId. It calls `delByPrefix` once for the new prefix and once for the legacy `stock:` prefix so entries written before the cut-over are wiped on the first post-deploy write.
docs/adr/016-cache-aside-generalized.md:40:Task-11 changes this to `await this.stockCache.invalidate(...)`. The post-state of a successful confirm RPC now includes "cache cleared for the mutated products" — the immediate next GET reads the fresh DB row.
docs/adr/016-cache-aside-generalized.md:42:This does NOT close `CACHE-001` (the read/write race between a reader's DB read and a writer's commit+invalidate); that race is bounded by TTL today and is tracked for a future single-flight / version-stamp pass.
docs/adr/016-cache-aside-generalized.md:61:## Still open
docs/adr/016-cache-aside-generalized.md:63:- `CACHE-001` (cache-aside read/write race / no single-flight)
docs/adr/016-cache-aside-generalized.md:64:- `CACHE-002` (post-commit invalidate contract enforced by comment)
docs/adr/016-cache-aside-generalized.md:65:- `CACHE-003` (no schema-version segment in keys)
docs/adr/016-cache-aside-generalized.md:66:- `CACHE-004` (no TTL jitter)
docs/adr/016-cache-aside-generalized.md:67:- `CACHE-005` (duplicate warn logs on Redis-down)
docs/adr/016-cache-aside-generalized.md:69:- `CACHE-009` (no tenant segment)
```

Real surface (verified by reading the live files):

```text
libs/cache/cache-keys.ts:33-34                          # INVENTORY_STOCK_KEY_VERSION + RETAIL_ORDER_KEY_VERSION constants — the version segment ADR-022 added
libs/cache/cache-keys.ts:48-49                          # rootPrefix(): opt-in `t:<tenantId>:` segment per ADR-022
libs/cache/cache-keys.ts:54-70                          # CACHE_KEYS.inventoryStock / inventoryStockPrefix / retailOrder / retailOrderPrefix all render `ris:[t:<tenantId>:]<service>:<aggregate>:v1:<id>[:<facet>]`
libs/cache/cache.port.ts:15                             # delByPrefix (ADR-016 — still present)
libs/cache/cache.port.ts:23                             # singleFlight (ADR-021 — post-ADR-016 addition)
apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts:43-57   # ADR-023: no public `invalidate(...)`; the seam is `withInvalidation(work, resolveItems, opts)`
apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts:65   # call-site uses `withInvalidation`, never the legacy `invalidate`
apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts:17-20     # comment header lists audit closures: CACHE-001/004 by ADR-021, CACHE-003/009 by ADR-022, CACHE-005 by the `available` flag
apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts:25        # JITTER_FRACTION — ADR-021 ±10% TTL jitter
apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts:141-153   # invalidatePrefixes fans three delByPrefix calls per productId (v1 / pre-v1 / pre-ADR-016 legacy) — not "once + once" as ADR-016 §2 claims
```

ADR-016 has no `## References` section today, so there is no graph to walk from ADR-016 → ADR-021 / ADR-022 / ADR-023.

## Why this matters

ADR-016 is the foundational ADR for the cache-aside generalization. A new contributor reading it in isolation will encounter:

1. A key shape (`ris:<service>:<aggregate>:<id>[:<facet>]`) that is **missing the version segment**. Code that writes to that literal renders entries the live `inventoryStockPrefix` builder would never produce — and would be invalidated by the post-commit `delByPrefix` calls only by accident (the pre-v1 legacy prefix happens to cover the same shape during the transition window). After the transition window closes, ADR-016-literal keys become silently orphaned. Same correctness regression family the supersession pointers for ADR-002 (`epic-00/task-02`) and ADR-006 (`epic-00/task-05`) flagged one layer up.
2. A `stockCache.invalidate({items, correlationId})` API surface that the live port deliberately removed in ADR-023. Calling `invalidate(...)` directly will not even compile against the current `IStockCachePort`. The only correct seam is `withInvalidation(work, resolveItems, opts)`, which awaits commit before fanning out `delByPrefix` — the type system enforces the ordering ADR-023 promised.
3. A "Still open" register where every item is already closed by an Accepted ADR in the catalogue. A reader treating that register as authoritative will spend their first PR re-solving CACHE-001/004 (single-flight + jitter) before realising ADR-021 already shipped both.
4. The "DOES NOT close CACHE-001" caveat on line 42, taken at face value, contradicts ADR-021's `singleFlight` primitive — a reader could argue the read/write race is still open today, when the in-process leader-follower coalescing in `RedisCacheAdapter` actually closes it for the same-process miss path.

So the gap between ADR-016 prose and live code mirrors the ADR-002 / ADR-006 gap exactly: a literal reading bypasses the safety rails the three downstream ADRs added on top.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-016 with a one-line Status pointer and add a `## References` section (recommended).**

ADR-003 line 62 permits "flipping its `Status` and adding a one-line pointer." Use that allowance:

- Replace `**Status**: Accepted` with `**Status**: Accepted (key shape, invalidation seam, and the "Still open" register superseded in part by ADR-021/022/023; see References)`.
- Add a new `## References` section at the bottom of the file (parallel to ADR-017's References section) with the chain entries:
  - `[ADR-021](021-cache-single-flight-and-ttl-jitter.md)` — adds `ICachePort.singleFlight(key, fn)` and ±10% TTL jitter on the StockCache write path. The "DOES NOT close CACHE-001" caveat in this ADR's §3 and the `CACHE-001` / `CACHE-004` rows of §"Still open" are closed here.
  - `[ADR-022](022-cache-keys-tenant-and-schema-version.md)` — inserts a per-aggregate schema-version segment and an opt-in `t:<tenantId>:` segment into every key. The `ris:<service>:<aggregate>:<id>[:<facet>]` literal in this ADR's §1 is now `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]` (reachable only via `CACHE_KEYS.*` builders). The `CACHE-003` / `CACHE-009` rows of §"Still open" are closed here.
  - `[ADR-023](023-cache-invalidate-post-commit-by-type.md)` — replaces the `await this.stockCache.invalidate(...)` pattern in this ADR's §3 with a type-enforced `IStockCachePort.withInvalidation(work, resolveItems, opts)` seam. The `CACHE-002` row of §"Still open" is closed here.
- Optionally, add one line noting that `CACHE-005` (duplicate warn logs on Redis-down) is closed by the `IStockCachePort.get` return shape carrying an `available` flag — pointer to CLAUDE.md §"Operational notes" rather than a separate ADR, since no ADR documents that change explicitly.

Do **not** rewrite the body of ADR-016's `## Decision` or `## Still open` sections. They stand as the historical snapshot of the task-11 surface; the supersession pointer + References redirect the reader to the current state.

**Option B — Write a new ADR-024 "Cache layer: current statement (port surface + key shape + invalidation seam)" that supersedes ADR-016 outright.**

Allocates ADR-024 to a freshly-written re-statement of the current cache layer. ADR-016 Status would flip to `Superseded by ADR-024`. Advantage: ADR-024 reads cleanly without a forward-reference graph. Cost: one extra ADR file to maintain and the historical inversion (ADR-021/022/023 chained from ADR-016 incrementally; ADR-024 would document the *result*). Also collides with option B in `epic-00/task-02` (ADR-002) and `epic-00/task-05` (ADR-006) — if all three options B are taken, ADR-024 would have to consolidate ADR-002, ADR-006, and ADR-016, which expands scope significantly. Weaker than option A.

## Scope

**In:**

- Edit `docs/adr/016-cache-aside-generalized.md` Status line + add a `## References` section (option A), or
- Allocate ADR-024 + author it as a re-statement of the current cache layer (option B).

**Out:**

- Any change to cache code under `libs/cache/` or `apps/inventory-microservice/src/modules/stock/infrastructure/cache/`.
- Any change to ADR-021 / ADR-022 / ADR-023 (those already describe the current state).
- Any change to ADR-002 (filed separately under `epic-00/task-02`) or ADR-006 (filed separately under `epic-00/task-05`). The three tasks form a supersession-pointer triple across the cache-aside lineage — handle them independently.
- Any rewrite of ADR-016's `## Decision` or `## Still open` bodies.
- Any deletion of the `inventoryStockLegacyPrefix` / `productStockPrefix` builders — those are invalidate-only seams maintained for the ADR-022 transition window; their removal is scoped to a later cache-key bump task.

## Exit criteria

- [ ] A reader landing on ADR-016 sees an explicit signal that the `ris:<service>:<aggregate>:<id>[:<facet>]` key shape, the `stockCache.invalidate(...)` API, and the `## Still open` register are historical, and a complete forward-reference chain through ADR-021 → ADR-022 → ADR-023.
- [ ] No other ADR's text was edited beyond what the resolution requires.
- [ ] `yarn lint` still passes (touching only `docs/adr/*.md` should be a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-016 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
