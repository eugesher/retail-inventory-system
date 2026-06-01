---
epic: epic-07
task_number: 10
title: Bump inventory stock cache key version v2 → v3
depends_on: [01, 02, 03, 04, 05, 06, 07, 08, 09]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/06-cache-key-bump-v2-to-v3.md
---

# Task 10 — Bump the stock cache key version `v2` → `v3`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-022](../../../docs/adr/022-cache-keys-tenant-and-schema-version.md) — the per-aggregate `<version>` constant; a breaking semantic change bumps it in one line; pre-bump entries age out via TTL.
  - [ADR-016](../../../docs/adr/016-cache-aside-generalized.md) — the `ris:<service>:<aggregate>:<version>:<id>[:<facet>]` key shape; `delByPrefix`; apps never write key literals (specs may assert them).
  - [ADR-023](../../../docs/adr/023-cache-invalidate-post-commit-by-type.md) — the legacy-prefix fan-out in `withInvalidation` (current `v3` + legacy `v2` + the pre-ADR-016 prefix) during the transition window.
  - [ADR-021](../../../docs/adr/021-cache-single-flight-and-ttl-jitter.md) — the read path (`getOrLoad`) is unchanged; only the key version moves.

## Goal

Bump `INVENTORY_STOCK_KEY_VERSION` from `'v2'` to `'v3'`. Per ADR-022, a version bump is warranted when the cached payload's *meaning* changes even if its field set does not — and that is exactly the case here. After this epic, the cached `StockLevel` projection's `quantityReserved` is now **actively mutated by the Reservation flow** (it used to ship at `0` and never move, post-`epic-04`). A client that read a `v2`-cached value and a client that reads a `v3` value can disagree about availability in a way they could not before, so the cached value is *functionally different* and the old entries must become unreachable on the next deploy.

This is a one-line constant change plus the legacy-prefix bookkeeping that ADR-023's `withInvalidation` fan-out requires, plus the spec updates that lock in the new literal.

## Entry state assumed

Tasks 01–09 carryover present:

- `libs/cache/cache-keys.ts` has `INVENTORY_STOCK_KEY_VERSION = 'v2'` and the `inventoryStock` / `inventoryStockPrefix` builders, plus the `inventoryStockLegacyPrefix` (pre-`v2`) + `productStockPrefix` (pre-ADR-016) prefixes that `epic-04` task-06 added.
- `StockCache.withInvalidation` fans out `delByPrefix` over: current `v2` prefix + the two legacy prefixes (ADR-023 transition window).
- The Reservation/Allocate/Release/Transfer use cases (tasks 03–07) route writes through `withInvalidation` and reads through `getOrLoad` — none write key literals.

## Scope

**In:**

- `libs/cache/cache-keys.ts` — `INVENTORY_STOCK_KEY_VERSION = 'v3'`; add `inventoryStockV2Prefix(...)` as the new *legacy* invalidate-only prefix (what was the live prefix becomes a legacy fan-out target); keep `inventoryStockLegacyPrefix` (pre-`v2`) and `productStockPrefix` (pre-ADR-016) as-is.
- `…/stock/infrastructure/cache/stock.cache.ts` — the `invalidatePrefixes` (private, behind `withInvalidation`) now fans out four prefixes: current `v3`, legacy `v2`, pre-`v2`, pre-ADR-016. (If the project prefers to retire the oldest as part of this bump, do so only with an explicit note in the doc — default is to keep them until a dedicated cleanup follow-up, per ADR-022.)
- `libs/cache/spec/cache-keys.spec.ts` — update the literal assertions to `ris:inventory:stock:v3:<variantId>[:<facet>]`; add an assertion that the `v2` prefix builder still produces the legacy literal (locks the fan-out target).
- `…/stock/infrastructure/cache/spec/stock.cache.spec.ts` — assert reads/writes use the `v3` key; assert `withInvalidation` fans out the `v3` + legacy prefixes.
- Doc deliverable `06-cache-key-bump-v2-to-v3.md`.

**Out:**

- Any change to the read/write *path* (still `getOrLoad` + `withInvalidation` — ADR-021/ADR-023).
- Retiring the oldest legacy prefixes — a future cleanup follow-up unless explicitly decided here.
- The README/CLAUDE cache-note text — task-13.

## The change

```ts
// libs/cache/cache-keys.ts

// Was 'v2' (epic-04). Bumped because quantityReserved is now actively mutated
// by the Reservation flow (epic-07) — the cached value is functionally different
// even though the field set is unchanged. See ADR-022.
export const INVENTORY_STOCK_KEY_VERSION = 'v3';

export const CACHE_KEYS = {
  inventoryStock(variantId: number, facet?: string, opts?: { tenantId?: string }): string {
    const t = opts?.tenantId ? `t:${opts.tenantId}:` : '';
    const base = `ris:${t}inventory:stock:${INVENTORY_STOCK_KEY_VERSION}:${variantId}`;
    return facet ? `${base}:${facet}` : base;
  },
  inventoryStockPrefix(variantId: number, opts?: { tenantId?: string }): string {
    const t = opts?.tenantId ? `t:${opts.tenantId}:` : '';
    return `ris:${t}inventory:stock:${INVENTORY_STOCK_KEY_VERSION}:${variantId}`;
  },
  // NEW legacy invalidate-only prefix: the prior live version.
  inventoryStockV2Prefix(variantId: number, opts?: { tenantId?: string }): string {
    const t = opts?.tenantId ? `t:${opts.tenantId}:` : '';
    return `ris:${t}inventory:stock:v2:${variantId}`;
  },
  // inventoryStockLegacyPrefix (pre-v2) + productStockPrefix (pre-ADR-016) unchanged.
} as const;
```

The `withInvalidation` fan-out in `StockCache` adds the new `v2` legacy prefix to the existing list so a row written under `v2` by a not-yet-redeployed replica is still invalidated during the rollout window:

```ts
private async invalidatePrefixes(items: IStockCacheInvalidateItem[], opts?: { correlationId?: string }): Promise<void> {
  for (const { variantId } of items) {
    await this.cache.delByPrefix(CACHE_KEYS.inventoryStockPrefix(variantId));        // v3 (current)
    await this.cache.delByPrefix(CACHE_KEYS.inventoryStockV2Prefix(variantId));       // v2 (legacy, this bump)
    await this.cache.delByPrefix(CACHE_KEYS.inventoryStockLegacyPrefix(variantId));   // pre-v2
    await this.cache.delByPrefix(CACHE_KEYS.productStockPrefix(variantId));           // pre-ADR-016
  }
}
```

## Files to add

- `docs/implementation/07-inventory-reservation-and-stock-movement/06-cache-key-bump-v2-to-v3.md`

## Files to modify

- `libs/cache/cache-keys.ts` — version constant + `inventoryStockV2Prefix`.
- `libs/cache/spec/cache-keys.spec.ts` — `v3` literal assertions + the `v2` legacy-prefix assertion.
- `apps/inventory-microservice/.../infrastructure/cache/stock.cache.ts` — add `v2` to the fan-out.
- `apps/inventory-microservice/.../infrastructure/cache/spec/stock.cache.spec.ts` — `v3` read/write + four-prefix fan-out assertions.

## Files to delete

None.

## Tests

`cache-keys.spec.ts`:

- `CACHE_KEYS.inventoryStock(42)` === `'ris:inventory:stock:v3:42'`; with a facet `'available'` === `'ris:inventory:stock:v3:42:available'`; with `{ tenantId: 'acme' }` === `'ris:t:acme:inventory:stock:v3:42'`.
- `CACHE_KEYS.inventoryStockV2Prefix(42)` === `'ris:inventory:stock:v2:42'` (the fan-out target).

`stock.cache.spec.ts`:

- A read writes/reads under the `v3` key (assert via the fake `CACHE_PORT`).
- `withInvalidation` (post-commit) calls `delByPrefix` for all four prefixes per item, in the documented order.

## Doc deliverable — `06-cache-key-bump-v2-to-v3.md`

Target ~90 lines. Sections:

1. **Why a bump for a semantic-only change.** ADR-022's rule: a version bump is warranted when the cached value's *meaning* changes even if the field set doesn't. Here `quantityReserved` goes from "always 0, dead" (post-`epic-04`) to "actively mutated by reservations" — a `v2` reader and a `v3` reader can legitimately disagree about availability, so `v2` entries must die.
2. **What unreachable `v2` entries look like.** After deploy, no code path reads `ris:inventory:stock:v2:*`; they age out via TTL (with the ±10% jitter from ADR-021). The legacy invalidate-only prefix means an in-flight `v2` write from a not-yet-redeployed replica during the rollout is still invalidated.
3. **The four-prefix fan-out.** Current `v3` + legacy `v2` + pre-`v2` + pre-ADR-016 — why each survives the transition window (ADR-023) and when they'll be cleaned up (a dedicated follow-up, not this epic).
4. **No read/write path change.** Still `getOrLoad` (single-flight + jitter) and `withInvalidation` (post-commit by type). Only the literal version segment moved.
5. **Greppability.** The live version is one constant in `libs/cache/cache-keys.ts`; `redis-cli --scan --pattern 'ris:inventory:stock:v3:*'` is the operational check (exit criterion).

## Carryover produced (consumed by task-11 onward)

- `INVENTORY_STOCK_KEY_VERSION = 'v3'`; the `v2` legacy invalidate-only prefix added.
- The cache specs lock in the `v3` literal + the four-prefix fan-out.
- Doc `06-cache-key-bump-v2-to-v3.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `cache-keys.spec.ts` + `stock.cache.spec.ts` assert the `v3` key and the four-prefix fan-out.
- [ ] No app file under `apps/*/src` writes a cache-key string literal (`grep` clean); the version lives only in `libs/cache/cache-keys.ts`.
- [ ] After a write, `redis-cli --scan --pattern 'ris:inventory:stock:v3:*'` shows `v3` entries; no `v2` entries are written on the new path (proven in task-11's e2e).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `06-cache-key-bump-v2-to-v3.md` exists with the sections above.
