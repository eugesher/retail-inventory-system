---
epic: epic-00
task_number: 18
title: Add ADR-022 supersession pointer for the stock-cache port surface + extend References to ADR-023
depends_on: []
doc_deliverable: null
---

# Task 18 — Add an ADR-022 supersession pointer for the stock-cache port surface and extend `## References` to ADR-023

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. In particular, read ADR-022 (especially §"3. Tenant is opt-in by argument, never defaulted" and the existing `## References` section), ADR-023 (the whole text — it is short, and the §"Decision" paragraph on `IStockCacheInvalidatePayload` retirement is the operative supersession), and ADR-003 §"Format" + §"Never edit a prior ADR in place beyond flipping its `Status` and adding a one-line supersession pointer" in full before deciding the wording of the pointer. CLAUDE.md §"Shared Libraries" → `@retail-inventory-system/cache` paragraph and §"Operational notes" → "Redis cache-aside is generalized" bullet are the live authorities on what is closed today.

## ADR audited

[ADR-022 — Cache-key schema-version and opt-in tenant segments](../../../docs/adr/022-cache-keys-tenant-and-schema-version.md). Accepted (2026-05-20).

## Discrepancy

ADR-022 and ADR-023 were committed on the same day (both dated 2026-05-20). ADR-022 quotes the *pre-ADR-023* stock-cache port surface — specifically the `IStockCacheInvalidatePayload` type — which ADR-023 §"Decision" then explicitly retires:

> ADR-023 §"2. Implementation" (`docs/adr/023-cache-invalidate-post-commit-by-type.md:107-110`): "declares the new method and **replaces the public `IStockCacheInvalidatePayload` type with an `IStockWithInvalidationOptions` interface (tenant + correlationId)**."

ADR-022 §"3. Tenant is opt-in by argument, never defaulted" (`docs/adr/022-cache-keys-tenant-and-schema-version.md:138-142`) still reads:

> "The stock-cache port (`IStockCacheGetPayload`, `IStockCacheSetPayload`, **`IStockCacheInvalidatePayload`**) carries an optional `tenantId` field today. Inventory use cases do not populate it — there is no tenant model in the domain yet — but the port surface is ready, so a future migration is a wiring change, not a contract change."

That third type no longer exists. The optional `tenantId` ADR-022 claims lives on `IStockCacheInvalidatePayload` lives on `IStockWithInvalidationOptions` today.

A secondary, related gap: ADR-022's existing `## References` section (lines 267-274) lists the prior ADRs in the cache lineage (ADR-002 / ADR-006 / ADR-016 / ADR-021) but no forward pointer to ADR-023. A reader landing on ADR-022 has no graph to walk to the same-day ADR that supersedes part of its port-surface claim.

The core *decision* of ADR-022 (per-aggregate schema-version constant + opt-in `t:<tenantId>:` segment near the key root; three-prefix invalidate during the v1 transition window) still holds verbatim in code. Only the port-surface mention is stale — the tenant flows through `IStockWithInvalidationOptions` (declared inside the same ADR-022 effort) rather than the now-retired `IStockCacheInvalidatePayload`.

Surface: `docs/adr/022-cache-keys-tenant-and-schema-version.md` (the ADR prose itself — §"3. Tenant is opt-in by argument, never defaulted" and the `## References` block).

## Evidence

ADR-022 still references the retired type:

```text
docs/adr/022-cache-keys-tenant-and-schema-version.md:138-142:The stock-cache port (`IStockCacheGetPayload`, `IStockCacheSetPayload`, `IStockCacheInvalidatePayload`) carries an optional `tenantId` field today.
```

ADR-023 retires it:

```text
docs/adr/023-cache-invalidate-post-commit-by-type.md:107-110:`apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts` declares the new method and replaces the public `IStockCacheInvalidatePayload` type with an `IStockWithInvalidationOptions` interface (tenant + correlationId).
```

Live port (verified by reading the file in full):

```text
apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts:5-12     # IStockCacheGetPayload — `tenantId?: string` present
apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts:14-21    # IStockCacheSetPayload — `tenantId?: string` present
apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts:36-41    # IStockWithInvalidationOptions — `tenantId?: string` + `correlationId?: string` — this is the surface ADR-022 §3 should cite
apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts:47-62    # IStockCachePort — get / set / getOrLoad / withInvalidation; no `invalidate(...)`, no `IStockCacheInvalidatePayload` type
```

A grep across `apps/**` and `libs/**` for the retired symbol confirms it has no live referents:

```bash
$ grep -rn "IStockCacheInvalidatePayload" apps/ libs/
# (no output)
```

ADR-022's existing References section (lines 267-274) omits ADR-023:

```text
docs/adr/022-cache-keys-tenant-and-schema-version.md:267-274:## References
- Source audit: [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md)
- Original audit: [`docs/audits/audit-2026-05-08.md`](../audits/audit-2026-05-08.md)
- Prior ADRs in the cache lineage: [ADR-002](002-redis-cache-aside-product-stock.md),
  [ADR-006](006-cache-aside-via-libs-cache.md),
  [ADR-016](016-cache-aside-generalized.md),
  [ADR-021](021-cache-single-flight-and-ttl-jitter.md)
```

ADR-023's References (lines 233-250), by contrast, *does* link back to ADR-022 — so the graph is one-directional today. The fix turns it bidirectional.

## Why this matters

A new contributor reading ADR-022 in isolation will:

1. Search for `IStockCacheInvalidatePayload` in the codebase and find nothing — leading to a "stale ADR" suspicion that erodes trust in the cache-lineage chain. The `IStockWithInvalidationOptions` interface that does carry the optional `tenantId` is mentioned nowhere in ADR-022, even though it was introduced as part of the same same-day effort.
2. Reach the `## References` section and see the prior-art chain (ADR-002/006/016/021) but no forward link to ADR-023, even though ADR-023 explicitly supersedes the `IStockCacheInvalidatePayload` reference. The reader has to know to grep across `docs/adr/` to discover the same-day successor.

Same regression family as the supersession pointers already filed for ADR-002 (`epic-00/task-02`), ADR-006 (`epic-00/task-05`), ADR-012 (`epic-00/task-12`), and ADR-016 (`epic-00/task-15`). The cache lineage is a five-ADR chain (002 → 006 → 016 → 021 → 022 → 023), and every load-bearing ADR in the chain except ADR-023 itself now needs a forward-pointer to its successor.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-022 with a one-line Status pointer and extend the existing `## References` section (recommended).**

ADR-003 line 62 permits "flipping its `Status` and adding a one-line pointer." Use that allowance:

- Replace `**Status**: Accepted` with `**Status**: Accepted (port-surface mention superseded in part by ADR-023; see References)`.
- Extend the existing `## References` block by adding a new entry alongside the prior-art chain:
  - `[ADR-023](023-cache-invalidate-post-commit-by-type.md)` — retires the public `IStockCacheInvalidatePayload` referenced in §"3. Tenant is opt-in by argument, never defaulted"; the optional `tenantId` field now lives on the `IStockWithInvalidationOptions` interface that `IStockCachePort.withInvalidation(work, resolveItems, opts)` accepts. ADR-022's per-aggregate schema-version segment and opt-in tenant segment are unchanged; only the type that carries the tenant on the invalidate path moved.

Do **not** rewrite §"3. Tenant is opt-in by argument, never defaulted". The historical snapshot stands as the record of what was true at write time; the Status flip + References extension redirect the reader to the current state.

**Option B — Write a new ADR-024 "Cache layer: current statement (port surface + key shape + invalidation seam)" that supersedes ADR-016 + ADR-022 outright.**

Allocates ADR-024 to a freshly-written re-statement of the current cache layer. ADR-016 and ADR-022 Status would flip to `Superseded by ADR-024`. Same downside as option B in `epic-00/task-15` for ADR-016 (consolidation scope grows; historical inversion); and the recommended path in `epic-00/task-02` / `task-05` / `task-12` / `task-15` was option A in each case, which keeps the per-ADR cost trivial. Mentioned for completeness only.

## Scope

**In:**

- Edit `docs/adr/022-cache-keys-tenant-and-schema-version.md` Status line + extend the existing `## References` section with the ADR-023 entry (option A), or
- Allocate ADR-024 + author it as a re-statement of the current cache layer (option B).

**Out:**

- Any change to cache code under `libs/cache/` or `apps/inventory-microservice/src/modules/stock/`.
- Any change to ADR-023 (it already links back to ADR-022 in its References).
- Any change to ADR-002 (filed separately under `epic-00/task-02`), ADR-006 (`epic-00/task-05`), ADR-012 (`epic-00/task-12`), or ADR-016 (`epic-00/task-15`). The five tasks form a supersession-pointer chain across the cache lineage — handle them independently.
- Any rewrite of ADR-022's `## Decision` or `## Consequences` bodies.

## Exit criteria

- [ ] A reader landing on ADR-022 sees an explicit signal that the `IStockCacheInvalidatePayload` reference in §3 is historical, and a forward-reference to ADR-023 in the `## References` section.
- [ ] The ADR-022 ↔ ADR-023 graph is bidirectional (ADR-023 already references ADR-022; ADR-022 now references ADR-023).
- [ ] No other ADR's text was edited beyond what the resolution requires.
- [ ] `yarn lint` still passes (touching only `docs/adr/*.md` should be a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-022 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
