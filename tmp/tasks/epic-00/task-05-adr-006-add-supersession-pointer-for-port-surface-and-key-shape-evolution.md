---
epic: epic-00
task_number: 5
title: Add ADR-006 supersession pointer for the port-surface + key-shape evolution chain (ADR-016/021/022/023)
depends_on: []
doc_deliverable: null
---

# Task 05 — Add an ADR-006 supersession pointer for the port-surface and key-shape evolution

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. In particular, read ADR-006, ADR-003, ADR-016, ADR-021, ADR-022, ADR-023 in full before deciding the wording of the pointer. CLAUDE.md §"Shared Libraries" → `@retail-inventory-system/cache` paragraph is the live authority on the port surface.

## ADR audited

[ADR-006 — Cache-aside via `libs/cache` port and adapter](../../../docs/adr/006-cache-aside-via-libs-cache.md). Accepted (2026-05-10).

## Discrepancy

ADR-006 §Decision (lines 33-44) and §"Relationship to ADR-002" (lines 52-65) describe the `libs/cache` surface as it stood at task-04, and explicitly declare the cache contract "preserved verbatim". Four later ADRs have evolved that surface without ADR-006's Status / References being amended:

| ADR-006 claim                                                  | Actual state today                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ICachePort` methods are `get`, `set`, `del`, `wrap`           | `libs/cache/cache.port.ts:6-23` exposes six methods: `get`, `set`, `del`, **`delByPrefix`** (ADR-016), `wrap`, **`singleFlight`** (ADR-021) |
| Cache key prefix `stock:<productId>:` and `*` sentinel for unfiltered key — "unchanged" | Prefix is `ris:[t:<tenantId>:]inventory:stock:v1:<productId>` (ADR-016 + ADR-022); sentinel is `__all__`, not `*` |
| Audit comments (CACHE-009 through CACHE-012) "preserved verbatim in `libs/cache/cache-keys.ts`" | Comment block was rewritten — `libs/cache/cache-keys.ts:1-30` now narrates three coexisting key families (current ADR-022 / pre-v1 ADR-016 / pre-ADR-016 legacy) instead of the original audit text |
| SCAN+UNLINK invalidation in the inventory façade "unchanged in task-04. Task-08 migrates the façade onto `ICachePort` and decides whether `del` should grow a `delByPattern` overload" | Resolved: `ICachePort.delByPrefix` (ADR-016) is the primitive; the inventory façade routes every write through `IStockCachePort.withInvalidation(work, resolveItems, opts)` (ADR-023), which awaits commit and only then fans out three internal `delByPrefix` calls during the ADR-022 transition window |
| `CacheHelper` "Kept for one release; the inventory façade migrates off it in task-08" | Façade migrated off it long ago; `CacheHelper` (`libs/cache/cache-keys.ts:100`) still defined with zero consumers (`grep -rn "CacheHelper" apps libs` shows only that one definition). Removal is queued in `tmp/tasks/epic-04-inventory-stock-level-and-location/task-06-bump-cache-key-version-v1-to-v2-rewrite-stock-cache.md:135,319,342` |
| "Stampede protection" deferred                                  | Resolved by ADR-021 — in-process `singleFlight` + ±10 % TTL jitter on writes                                                  |
| "Schema-version prefixes" deferred                              | Resolved by ADR-022 — per-aggregate `v1` segment baked into every builder                                                      |

The core *decision* (introduce a port and adapter so domain code depends on `ICachePort` rather than `Cache` from `@nestjs/cache-manager`) still holds — that is exactly what the four downstream ADRs build on. It's the *snapshot of the surface* that is stale. ADR-006's Status is still `Accepted` with no supersession pointer; it has no `## References` section at all.

Surface: `docs/adr/006-cache-aside-via-libs-cache.md` (the ADR prose itself).

## Evidence

ADR-006 prose still cites the original surface:

```text
docs/adr/006-cache-aside-via-libs-cache.md:38:| `ICachePort` | The interface domain/façade code depends on. Methods: `get<T>`, `set<T>`, `del`, `wrap<T>` (read-through). |
docs/adr/006-cache-aside-via-libs-cache.md:43:| `CacheHelper` | Backwards-compat shim that delegates to `CACHE_KEYS`. Kept for one release; the inventory façade migrates off it in task-08. |
docs/adr/006-cache-aside-via-libs-cache.md:58:- Cache key prefix (`stock:<productId>:`) and `*` sentinel for the
docs/adr/006-cache-aside-via-libs-cache.md:60:- SCAN+UNLINK invalidation in the inventory façade — unchanged in
docs/adr/006-cache-aside-via-libs-cache.md:61:  task-04. Task-08 migrates the façade onto `ICachePort` and decides
docs/adr/006-cache-aside-via-libs-cache.md:62:  whether `del` should grow a `delByPattern` overload to absorb the
```

Real port surface (verified by reading `libs/cache/cache.port.ts`):

```text
libs/cache/cache.port.ts:6-23                           # six methods: get / set / del / delByPrefix / wrap / singleFlight
libs/cache/cache-keys.ts:54-97                          # CACHE_KEYS.inventoryStock + inventoryStockPrefix + retailOrder + retailOrderPrefix + catalogPricePrefix + legacy builders
libs/cache/cache-keys.ts:100                            # CacheHelper class still present, zero consumers
apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts  # withInvalidation post-commit wrapper (ADR-023)
```

ADR-006 has no `## References` section today, so there is no graph to walk from ADR-006 → its supersession chain (ADR-016/021/022/023).

## Why this matters

ADR-006 is the foundational ADR for the `libs/cache` port-and-adapter pattern. A new contributor reading it in isolation will encounter:

1. An `ICachePort` documented as having four methods. The real port has six, and **two of the missing methods (`delByPrefix`, `singleFlight`) are the very ones that close the audit items ADR-002 listed as open trade-offs**. A reader who treats the four-method surface as canonical will miss the existence of single-flight / prefix-invalidation entirely.
2. A "stampede protection ... out of scope" line that contradicts the actual surface (`singleFlight` exists since ADR-021).
3. A key-shape paragraph that says `stock:<productId>:` is "unchanged". The real prefix is `ris:[t:<tenantId>:]inventory:stock:v1:<productId>:` (ADR-022). Code that follows the ADR-006 literal would never be invalidated by the post-commit `delByPrefix` calls keyed on the current shape — the same correctness regression flagged in epic-00/task-02 for ADR-002.
4. A `CacheHelper` "kept for one release" promise that has long expired; a reader could mistake it for a still-supported API and import it into new code.

So the gap between ADR-006 prose and live code mirrors the ADR-002 gap one layer down: a literal reading produces code that bypasses the current safety rails (single-flight, key versioning, type-enforced post-commit invalidation).

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-006 with a one-line Status pointer and add a `## References` section (recommended).**

ADR-003 line 62 permits "flipping its `Status` and adding a one-line pointer." Use that allowance:

- Replace `**Status:** Accepted` with `**Status:** Accepted (port surface and key shape superseded in part by ADR-016 → ADR-023; see References)`.
- Add a new `## References` section at the bottom of the file (parallel to ADR-002's References section) with the chain entries:
  - `[ADR-016](016-cache-aside-generalized.md)` — generalises the cache-aside pattern beyond product stock; adds `ICachePort.delByPrefix` to the port surface and moves the key shape to `ris:<service>:<aggregate>:<id>[:<facet>]`. The "fat-`common` cache helper" and "SCAN+UNLINK in the façade" lines in this ADR's §"Relationship to ADR-002" are superseded here.
  - `[ADR-021](021-cache-single-flight-and-ttl-jitter.md)` — adds `ICachePort.singleFlight(key, fn)` and ±10 % TTL jitter on the StockCache write path. The "stampede protection ... out of scope" line in this ADR's §"What this ADR explicitly does **not** decide" is closed here.
  - `[ADR-022](022-cache-keys-tenant-and-schema-version.md)` — inserts a per-aggregate schema-version segment and an opt-in tenant segment into every key. The `stock:<productId>:` prefix and `*` sentinel in this ADR's §"Relationship to ADR-002" are now `ris:[t:<tenantId>:]inventory:stock:v1:<productId>:` and `__all__` respectively (reachable only via `CACHE_KEYS.inventoryStock(...)`).
  - `[ADR-023](023-cache-invalidate-post-commit-by-type.md)` — replaces ad-hoc invalidation with a type-enforced post-commit `IStockCachePort.withInvalidation(work, resolveItems, opts)` helper. The "task-08 decides whether `del` should grow a `delByPattern` overload" line in this ADR's §"Relationship to ADR-002" is resolved here.
- Optionally, add one line noting that `CacheHelper`'s removal is now queued in `tmp/tasks/epic-04-inventory-stock-level-and-location/task-06-bump-cache-key-version-v1-to-v2-rewrite-stock-cache.md`, so a reader does not import it into new code.

Do **not** rewrite the body of ADR-006's Decision, "Relationship to ADR-002", or "What this ADR explicitly does **not** decide" sections. They stand as the historical snapshot of the task-04 surface; the supersession pointer + References redirect the reader to the current state.

**Option B — Write a new ADR-024 "Cache port surface and key shape: current statement" that supersedes ADR-006 outright.**

Allocates ADR-024 to a freshly-written re-statement of the current port and key conventions, with ADR-006 Status flipped to `Superseded by ADR-024`. The advantage is that ADR-024 reads cleanly without a forward-reference graph. The cost is one extra ADR file to maintain and the historical inversion (ADR-016/021/022/023 chained from ADR-006 incrementally; ADR-024 would document the *result* of that chain). Also collides with the same option B in epic-00/task-02 for ADR-002 — if both options B are taken, ADR-024 would have to consolidate both ADR-002 and ADR-006, which expands scope further. Weaker than option A.

## Scope

**In:**

- Edit `docs/adr/006-cache-aside-via-libs-cache.md` Status line + add a `## References` section (option A), or
- Allocate ADR-024 + author it as a re-statement of the current port surface and key shape (option B).

**Out:**

- Any change to cache code under `libs/cache/` or `apps/inventory-microservice/src/modules/stock/infrastructure/cache/`.
- Any change to ADR-016 / ADR-021 / ADR-022 / ADR-023 (those already describe the current state).
- Any change to ADR-002 (filed separately under epic-00/task-02) or ADR-001 / ADR-003 / ADR-004 (filed elsewhere under epic-00).
- Any rewrite of ADR-006's `## Decision`, `## Relationship to ADR-002`, or `## What this ADR explicitly does **not** decide` bodies.
- Deleting `CacheHelper` — that is queued in `epic-04/task-06`.

## Exit criteria

- [ ] A reader landing on ADR-006 sees an explicit signal that the `ICachePort` four-method surface and the `stock:<productId>:` key shape are historical, and a complete forward-reference chain through ADR-016 → ADR-023.
- [ ] No other ADR's text was edited beyond what the resolution requires.
- [ ] `yarn lint` still passes (touching only `docs/adr/*.md` should be a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-006 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
