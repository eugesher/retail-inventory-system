---
epic: epic-04
task_number: 6
title: Bump the cache key version v1 → v2 and rewrite StockCache against the new shape
depends_on: [01, 02, 03, 04, 05]
doc_deliverable: docs/implementation/epic-04-inventory-stock-level-and-location/04-cache-key-bump-v1-to-v2.md
---

# Task 06 — Bump the cache key `v1` → `v2` and rewrite `StockCache`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Land the ADR-022-style version bump: `INVENTORY_STOCK_KEY_VERSION` changes from `'v1'` to `'v2'`, the `inventoryStockPrefix` / `inventoryStock` builders rekey from `productId` to `variantId`, the legacy `v1` shape is retained as **invalidate-only** so any in-flight pre-bump entries get wiped during the rolling deploy that adopts v2, and `StockCache` is rewritten to the full v2 implementation: real `get` / `set` / `getOrLoad` / `withInvalidation` against the new `IStockAvailabilityProjection` payload, single-flight + TTL jitter inherited, the three-prefix invalidate scan (v2 + legacy v1 + pre-ADR-016 `productStock`). Cached value shape changes from a SUM aggregate to the `IStockAvailabilityProjection` from task-05.

This is the only task in the epic that touches `libs/cache/`. It does not touch any other library.

## Entry state assumed

Task-05 carryover present:

- `IStockCachePort` reshaped to the `variantId` / `stockLocationId` payload shape.
- `IStockAvailabilityProjection` defined at `libs/contracts/inventory/stock-availability/`.
- `StockCache` is in a transitional no-op state — `get` returns `{ value: undefined, available: true }`, `set` is a no-op, `getOrLoad` calls the loader unconditionally, `withInvalidation` runs `work` and skips the prefix-delete.
- `stock.cache.spec.ts` is `describe.skip(...)`'d.
- `libs/cache/cache-keys.ts` still carries `inventoryStockPrefix(productId, …)` / `inventoryStock(productId, …)` / `inventoryStockLegacyPrefix(productId)` / `productStockPrefix(productId)` / `productStock(productId, …)` — none touched yet.

## Scope

**In:**

- Rewrite `libs/cache/cache-keys.ts`:
  - Bump `INVENTORY_STOCK_KEY_VERSION` from `'v1'` to `'v2'`.
  - Replace `inventoryStockPrefix(productId, opts?)` with `inventoryStockPrefix(variantId, opts?)`. Body uses the new version constant and the new id parameter; the rendered prefix is `ris:[t:<tenantId>:]inventory:stock:v2:<variantId>:`.
  - Replace `inventoryStock(productId, storageIds?, opts?)` with `inventoryStock(variantId, stockLocationIds?, opts?)`. Body uses the new prefix builder; the facet semantics are unchanged (sorted, comma-joined, `__all__` sentinel on empty).
  - Add a **second** invalidate-only legacy prefix entry. The pre-existing `inventoryStockLegacyPrefix(productId)` (pre-v1, post-ADR-016) stays exactly as it is — it was already invalidate-only — but is **renamed** to `inventoryStockProductIdLegacyPrefix(productId)` to distinguish it from the new entry. The new entry is `inventoryStockV1LegacyPrefix(productId)` returning `ris:inventory:stock:v1:<productId>:`. Both exist solely for the SCAN+UNLINK invalidate path; reads and writes use `inventoryStockPrefix` (v2).
  - `productStockPrefix(productId)` and `productStock(productId, …)` (the pre-ADR-016 legacy) stay — they continue to be wiped by the invalidate path for one more transition window (the ADR-023 §"transition window" decision is "keep wiping until two epochs have elapsed since the last write under the prefix"; the v1 → v2 bump does not start the clock fresh on the pre-ADR-016 prefix).
  - The rationale comment block at the top of `cache-keys.ts` is updated to describe **three** key families coexisting: current (v2), pre-bump v1 (invalidate-only — new), pre-ADR-016 (invalidate-only — existing). The `productId`-keyed v1 builder is documented as the cross-coordinate-system bridge: the legacy prefix is keyed by `productId` even though the new prefix is keyed by `variantId`, because the v1 entries currently in Redis (if any — there are none in this test environment but the production-rollout discussion still applies) were written under that shape.
  - The `CacheHelper` backwards-compat alias surface is deleted — no production caller uses it (it points at `productStockPrefix` / `productStock` only); a `grep` confirms zero references outside `libs/cache/` itself.

- Update `libs/cache/spec/cache-keys.spec.ts`:
  - New assertions on the v2 builders (rendered output matches `ris:inventory:stock:v2:<variantId>:<facet>`).
  - Update the existing `inventoryStockLegacyPrefix` test to point at the renamed `inventoryStockProductIdLegacyPrefix`.
  - New assertions on `inventoryStockV1LegacyPrefix`.

- Rewrite `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`:
  - Mirror the structure of the pre-task-05 implementation — same logging conventions, same `ICachePort` injection, same single-flight + jitter inheritance.
  - The `get` / `set` / `getOrLoad` methods are typed by `IStockAvailabilityProjection` end-to-end.
  - `withInvalidation(work, resolveItems, opts?)` invalidates **three prefixes per variantId** plus, for any pre-existing legacy entry in Redis, **three prefixes per inferred-productId**. But — the new mutator paths only know `variantId`, not `productId`. The legacy `productId` is unrecoverable without a join through catalog. Resolution: the legacy prefixes (`v1`, pre-ADR-016) are wiped not by per-call invalidation but by a **one-shot drain at startup** that runs `SCAN MATCH ris:inventory:stock:v1:* | UNLINK` and `SCAN MATCH stock:* | UNLINK` exactly once per service boot, behind a `CACHE_DRAIN_LEGACY_ON_BOOT=true` env flag. The flag defaults to `true` for this deploy and is removed two epochs later. This is documented in the doc deliverable.
  - The per-call invalidate fires `cache.delByPrefix(CACHE_KEYS.inventoryStockPrefix(variantId, { tenantId }))` only — the legacy prefixes are not iterated per-call because there is no productId in scope.
  - The startup-drain logic lives in `StockCache.onApplicationBootstrap()` (Nest lifecycle hook). It runs once, logs `legacyDrainComplete` with a count, and never runs again.

- Rewrite `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`:
  - ≥10 cases covering: `get` cache-hit / cache-miss / Redis-down (`available: false`); `set` success / Redis-down warn; `getOrLoad` cache-hit short-circuit / cache-miss + write-back / Redis-down skip; `withInvalidation` work-runs-then-prefix-delete order; the startup-drain runs once and is idempotent on re-entry.
  - The legacy v1 / pre-ADR-016 prefix names are asserted explicitly so a future contributor renaming them in `cache-keys.ts` will see the test fail rather than silently breaking the invalidate sweep.

- Doc deliverable `04-cache-key-bump-v1-to-v2.md`.

**Out:**

- The api-gateway side caching wiring — there is none in this epic (the gateway forwards the projection through to the client; the cache lives in the inventory microservice).
- The variant-created consumer — task-07.
- The RMQ publisher — task-08.

## `libs/cache/cache-keys.ts` — concrete after-state

The file's three sections (current convention / pre-v1 invalidate-only / pre-ADR-016 invalidate-only) are kept structurally. The post-task shape:

```ts
const INVENTORY_STOCK_KEY_VERSION = 'v2'; // bumped from 'v1' by epic-04 task-06
const RETAIL_ORDER_KEY_VERSION = 'v1';   // unchanged

// ... ALL_FACETS_SENTINEL, rootPrefix, sortedStorageFacet unchanged ...
// Rename the helper signature from sortedStorageFacet(storageIds) to
// sortedFacet(ids) — the function is now used for both stockLocationIds
// (string list) and the future retail-order facet; the rename signals the
// generic shape. Update the one in-file caller.

export const CACHE_KEYS = {
  // -- Current convention (ADR-022 — version + opt-in tenant) ---------------
  // KEYED BY variantId — the inventory aggregate root for stock reads in
  // epic-04 onward. Pre-bump entries (productId-keyed) get drained by the
  // startup-drain in StockCache.onApplicationBootstrap.
  inventoryStockPrefix: (variantId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}inventory:stock:${INVENTORY_STOCK_KEY_VERSION}:${variantId}:`,

  inventoryStock: (
    variantId: number,
    stockLocationIds?: string[],
    opts?: ITenantOptions,
  ): string => {
    const prefix = CACHE_KEYS.inventoryStockPrefix(variantId, opts);
    const facet =
      stockLocationIds && stockLocationIds.length > 0
        ? sortedFacet(stockLocationIds)
        : ALL_FACETS_SENTINEL;
    return `${prefix}${facet}`;
  },

  // -- retailOrder* unchanged ---

  // -- Pre-bump v1 shape — invalidate-only --------------------------------
  // Renamed from `inventoryStockLegacyPrefix` so the file carries two distinct
  // legacy entries (pre-v1 productId-keyed and pre-ADR-016 stock:<id>:) and
  // the rename clarifies which.
  //
  // Returns `ris:inventory:stock:v1:<productId>:`. Single-tenant by
  // construction (the pre-v1 shape never carried a tenant segment). Used by
  // StockCache.onApplicationBootstrap for the one-shot SCAN+UNLINK drain
  // after the v1 → v2 bump.
  inventoryStockProductIdLegacyPrefix: (productId: number): string =>
    `ris:inventory:stock:v1:${productId}:`,

  // -- Pre-ADR-016 legacy convention --------------------------------------
  // Unchanged. Same one-shot drain target.
  productStockPrefix: (productId: number): string => `stock:${productId}:`,

  productStock: (productId: number, storageIds?: string[]): string => {
    const prefix = CACHE_KEYS.productStockPrefix(productId);
    const storageKey =
      storageIds && storageIds.length > 0
        ? [...storageIds].sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0)).join(',')
        : '*';
    return `${prefix}${storageKey}`;
  },
} as const;
```

Note: the `inventoryStockLegacyPrefix` symbol is gone — its callers (only `StockCache`) get rewritten in this task. A grep across `apps/*` and `libs/*` for `inventoryStockLegacyPrefix` should return zero hits at end-of-task.

The `CacheHelper` class at the bottom of the file is **deleted** in this task. The grep confirms zero callers outside `libs/cache/`. (If a caller is found, this task adds a TODO and defers the deletion to task-10 — but the survey done at the start of this epic shows none.)

## `stock.cache.ts` — full v2 implementation outline

```ts
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CACHE_KEYS, CACHE_PORT, ICachePort } from '@retail-inventory-system/cache';
import { IStockAvailabilityProjection } from '@retail-inventory-system/contracts';

import {
  IStockCacheGetPayload,
  IStockCacheGetResult,
  IStockCacheInvalidateItem,
  IStockCachePort,
  IStockCacheSetPayload,
  IStockWithInvalidationOptions,
} from '../../application/ports';

@Injectable()
export class StockCache implements IStockCachePort, OnApplicationBootstrap {
  private static readonly JITTER_FRACTION = 0.1;
  private static readonly LEGACY_DRAIN_PATTERNS = [
    // SCAN MATCH patterns used by the one-shot startup drain. The v1
    // productId-keyed pattern is `ris:inventory:stock:v1:*`; the
    // pre-ADR-016 pattern is `stock:*` — pick a SCAN COUNT that bounds
    // single-iteration latency (1000 is the project default; verify against
    // libs/cache/redis-cache.adapter.ts).
    'ris:inventory:stock:v1:*',
    'stock:*',
  ];

  constructor(
    @Inject(CACHE_PORT) private readonly cache: ICachePort,
    private readonly configService: ConfigService,
    @InjectPinoLogger(StockCache.name) private readonly logger: PinoLogger,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    const enabled = this.configService.get<string>('CACHE_DRAIN_LEGACY_ON_BOOT') !== 'false';
    if (!enabled) return;
    let totalUnlinked = 0;
    try {
      for (const pattern of StockCache.LEGACY_DRAIN_PATTERNS) {
        // delByPrefix's signature treats the argument as a literal prefix
        // (already SCAN MATCH <prefix>*). The patterns above already end in
        // `:` or are prefix-like, so they compose correctly.
        const n = await this.cache.delByPrefix(pattern.replace(/\*$/, ''));
        totalUnlinked += n;
      }
      this.logger.info({ totalUnlinked }, 'Legacy cache drain complete');
    } catch (error) {
      this.logger.warn({ err: error as Error }, 'Legacy cache drain failed (continuing)');
    }
  }

  public async get(payload: IStockCacheGetPayload): Promise<IStockCacheGetResult> {
    const { variantId, stockLocationIds, tenantId, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(variantId, stockLocationIds, { tenantId });
    try {
      const cached = await this.cache.get<IStockAvailabilityProjection>(cacheKey);
      this.logger.debug(
        { correlationId, variantId, cacheKey, cacheHit: cached !== undefined },
        cached !== undefined ? 'Cache hit for stock query' : 'Cache miss for stock query',
      );
      return { value: cached, available: true };
    } catch (error) {
      this.logger.warn({ err: error as Error, correlationId, variantId, cacheKey }, 'Failed to read from cache');
      return { value: undefined, available: false };
    }
  }

  public async set(payload: IStockCacheSetPayload): Promise<void> {
    const { variantId, stockLocationIds, tenantId, data, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(variantId, stockLocationIds, { tenantId });
    const ttl = this.jitterTtl(this.configuredTtl());
    try {
      await this.cache.set(cacheKey, data, ttl);
      this.logger.debug({ correlationId, variantId, cacheKey, ttl }, 'Cache write for stock query');
    } catch (error) {
      this.logger.warn({ err: error as Error, correlationId, variantId, cacheKey }, 'Failed to write to cache');
    }
  }

  public async getOrLoad(
    payload: IStockCacheGetPayload,
    loader: () => Promise<IStockAvailabilityProjection>,
  ): Promise<IStockAvailabilityProjection> {
    const { variantId, stockLocationIds, tenantId, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(variantId, stockLocationIds, { tenantId });
    const { value, available } = await this.get(payload);
    if (value !== undefined) return value;
    if (!available) return loader();

    return this.cache.singleFlight(cacheKey, async () => {
      const insideLeader = await this.get(payload);
      if (insideLeader.value !== undefined) return insideLeader.value;
      const data = await loader();
      // Skip the write-back when `data.levels` is empty — see doc 07 §"skip-on-empty".
      if (insideLeader.available && data.levels.length > 0) {
        await this.set({ variantId, stockLocationIds, tenantId, data, correlationId });
      }
      return data;
    });
  }

  public async withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T> {
    const result = await work();
    const items = resolveItems(result);
    if (items.length > 0) {
      await this.invalidatePrefixes(items, opts);
    }
    return result;
  }

  private async invalidatePrefixes(
    items: IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<void> {
    const { tenantId, correlationId } = opts ?? {};
    const variantIds = [...new Set(items.map((i) => i.variantId))];
    let totalUnlinked = 0;
    try {
      const counts = await Promise.all(
        variantIds.map((variantId) =>
          this.cache.delByPrefix(CACHE_KEYS.inventoryStockPrefix(variantId, { tenantId })),
        ),
      );
      totalUnlinked = counts.reduce((sum, n) => sum + n, 0);
    } catch (error) {
      this.logger.warn({ err: error as Error, correlationId, variantIds }, 'Failed to invalidate stock cache');
      return;
    }
    if (totalUnlinked === 0) {
      this.logger.debug(
        { correlationId, variantIds, itemCount: items.length },
        'No matching stock cache keys to invalidate',
      );
      return;
    }
    this.logger.debug(
      { correlationId, variantIds, itemCount: items.length, keyCount: totalUnlinked },
      'Stock cache invalidated via prefix delete',
    );
  }

  // configuredTtl, jitterTtl — same as pre-task-05.
}
```

Two differences worth highlighting vs the pre-epic-04 implementation:

- **Per-call invalidate is single-prefix.** The old code iterated three prefixes per `productId` (v1, pre-v1, pre-ADR-016). The new code iterates one prefix per `variantId` (v2). The two legacy prefixes are wiped by the one-shot startup drain instead. **Why**: per-call wipes of the legacy `productId`-keyed prefixes would require a `variantId → productId` lookup at mutation time, which means a catalog cross-call per write. The startup drain is one-time, runs once per service boot, and clears the legacy entries before any new write can need them.
- **Skip-on-empty write-back.** The `getOrLoad` no longer writes a cached entry when `data.levels.length === 0`. Documented in doc 07; ensures a missing auto-init row (task-07) is not cached as "no stock".

## `libs/cache/spec/cache-keys.spec.ts` — what to update

The existing spec exercises `inventoryStockPrefix(productId, …)` / `inventoryStock(productId, …)` / `inventoryStockLegacyPrefix(productId)` / `productStockPrefix(productId)` / `productStock(productId, …)`. After this task:

- The first two become `variantId`-parameterized. Update the assertions to render `ris:inventory:stock:v2:<variantId>:<facet>`. Add at least one assertion that the rendered string starts with `ris:` (not `ris:inventory:stock:v1:`) so a future revert of the version bump fails loudly.
- The `inventoryStockLegacyPrefix` test is renamed to point at `inventoryStockProductIdLegacyPrefix`. Add a new test for `inventoryStockV1LegacyPrefix` rendering `ris:inventory:stock:v1:<productId>:` — the pre-bump v1 entries.
- The `productStockPrefix` / `productStock` tests are unchanged (pre-ADR-016 legacy is untouched).
- The `CacheHelper` test, if one exists, is **deleted** alongside the class.

## Files to add

- `docs/implementation/epic-04-inventory-stock-level-and-location/04-cache-key-bump-v1-to-v2.md`

## Files to modify

- `libs/cache/cache-keys.ts` — version bump + builder rename + new legacy entry + comment block rewrite + `CacheHelper` deletion.
- `libs/cache/spec/cache-keys.spec.ts` — assertion updates per above.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts` — full v2 implementation.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts` — full v2 spec (replaces the `describe.skip(...)` from task-05).
- `libs/config/` if the project uses a Joi schema for env vars: register `CACHE_DRAIN_LEGACY_ON_BOOT` (boolean, default `'true'`). If a Joi schema does not exist, the var is read directly from `process.env` via `ConfigService` and no schema update is needed — verify against existing patterns.

## Files to delete

- The `CacheHelper` class block at the bottom of `libs/cache/cache-keys.ts` (its `*.spec.ts` file if separate — verify by grep).

## Tests

- `libs/cache/spec/cache-keys.spec.ts` — updated per above; ≥6 cases green.
- `apps/inventory-microservice/.../infrastructure/cache/spec/stock.cache.spec.ts` — ≥10 cases green (full v2 spec).
- `yarn test:unit` passes; the cache-key spec change is the only delta to `libs/cache/`.
- `yarn build` passes across all microservices.

## Doc deliverable

Write `docs/implementation/epic-04-inventory-stock-level-and-location/04-cache-key-bump-v1-to-v2.md`. Target ~160 lines. Sections:

1. **ADR-022 recap.** Per-aggregate schema-version constant; bumping it is a one-line edit that re-keys every entry on next deploy. Cross-link `libs/cache/cache-keys.ts` rationale comment block.
2. **What changed at the key shape.** The `productId` → `variantId` parameter swap. The new key shape: `ris:[t:<tenantId>:]inventory:stock:v2:<variantId>:<facet>`. The facet semantics are unchanged (sorted, comma-joined, `__all__` sentinel).
3. **Why a bump and not an in-place edit.** The cached value shape itself changed (from SUM aggregate to `IStockAvailabilityProjection`); reading a pre-bump entry under the post-bump deserializer would produce a `TypeError` or, worse, a silent shape mismatch. ADR-022's version segment is the deterministic shape-break the cache needs to express.
4. **Three key families coexisting.** Recap:
   - **v2** (current) — `ris:[t:…]inventory:stock:v2:<variantId>:<facet>`. Read+write.
   - **pre-bump v1** (`inventoryStockV1LegacyPrefix`) — `ris:inventory:stock:v1:<productId>:`. Invalidate-only via the startup drain. Will be removed after two deploy epochs (cite the project's "two epochs" rule from ADR-022 §"transition window").
   - **pre-ADR-016** (`productStockPrefix`) — `stock:<productId>:`. Invalidate-only. Same startup-drain target.
5. **The one-shot startup drain.** Why per-call invalidate cannot touch the legacy prefixes (the new mutator only knows `variantId`; the legacy entries are keyed by `productId`; a per-call `variantId → productId` lookup would require a cross-service call on every write). The drain runs in `StockCache.onApplicationBootstrap()` once per service boot. The `CACHE_DRAIN_LEGACY_ON_BOOT` env flag (default `'true'`) lets ops disable it for one specific debugging scenario; the flag is removed two epochs from now.
6. **What unreachable v1 entries on Redis will look like.** A `redis-cli --scan --pattern 'ris:inventory:stock:v1:*'` after the deploy returns the residual v1 entries the drain wiped. If any entries appear, they are post-drain re-writes — none of those can happen under the new code path (no caller of the v1 builder remains; the builder is invalidate-only). The doc explicitly says: "if a v1-prefixed key appears in Redis after this deploy, something is wrong; do not 'fix' it by writing more v1 entries — instead trace the writer".
7. **The skip-on-empty rule.** Why `getOrLoad` does not cache an empty `levels` array. Cross-link doc 07.
8. **The `CacheHelper` class deletion.** No external callers (verified by grep at end-of-task); the alias surface that was kept for backwards compatibility is no longer needed.
9. **Forward links.** Task-07 (variant-created consumer — produces the rows the cache will then load), task-08 (publisher — the events whose downstream consumers don't touch the cache), task-09 (api-gateway — the only caller of `QueryAvailabilityUseCase` from this epic on).

## Carryover produced (consumed by task-07 onward)

- `INVENTORY_STOCK_KEY_VERSION = 'v2'` in `libs/cache/cache-keys.ts`.
- New builders: `inventoryStockPrefix(variantId, …)`, `inventoryStock(variantId, stockLocationIds, …)`, `inventoryStockV1LegacyPrefix(productId)`.
- Old builder names gone: `inventoryStockLegacyPrefix` renamed; the `CacheHelper` class deleted.
- `StockCache` is the full v2 implementation; its spec covers ≥10 cases.
- One-shot legacy drain runs at service boot.
- Doc `04-cache-key-bump-v1-to-v2.md` complete.

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; ≥10 stock-cache cases green; ≥6 cache-keys cases green.
- [ ] `yarn build` passes.
- [ ] `grep -rn "inventoryStockLegacyPrefix" apps libs` returns zero hits.
- [ ] `grep -rn "CacheHelper" apps libs` returns zero hits.
- [ ] `grep -n "INVENTORY_STOCK_KEY_VERSION" libs/cache/cache-keys.ts` shows the constant set to `'v2'`.
- [ ] Manual smoke: `docker compose up -d && yarn start:dev:inventory-microservice`, observe one Pino log line `Legacy cache drain complete` with a `totalUnlinked` count (`0` on a fresh Redis).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `04-cache-key-bump-v1-to-v2.md` exists with the nine sections above filled.
