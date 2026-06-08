# Inventory stock cache: the `v1 → v2` key-version bump

The inventory availability read path is cached with Redis cache-aside. When the
inventory model moved from an append-only per-product ledger to per-location
running totals keyed on the catalog **variant**
([03-stocklevel-aggregate-and-version-column.md](03-stocklevel-aggregate-and-version-column.md)),
the **shape of the cached value changed**. Under the per-aggregate cache-key
schema-version rule ([ADR-022](../../adr/022-cache-keys-tenant-and-schema-version.md)),
a breaking change to a cached value's shape is recorded by bumping that
aggregate's version constant. This document explains the bump from `v1` to `v2`,
the new key shape, the four key families that briefly coexist, and what happens
to the old entries.

## Why a shape change forces a version bump

A cache key identifies a slot; the value stored in that slot has an implied
schema. If two deployments disagree about that schema but reuse the same key, the
newer code can read a value the older code wrote and mis-parse it. The schema
version segment in the key prevents that: bump it, and every new read/write lands
on a **different** key, so the old and new shapes never alias.

The value shape genuinely changed here:

- **Before (`v1`).** The cached value was a per-**product** `SUM` aggregate — the
  response of the old `inventory.product-stock.get` RPC, keyed on `productId`.
  The number it cached was the result of a `SUM(quantity) ... GROUP BY` over the
  append-only ledger.
- **After (`v2`).** The cached value is a per-**variant** projection,
  `VariantStockView`: a list of per-location `StockLevelView` rows
  (`quantityOnHand` / `quantityAllocated` / `quantityReserved` / derived
  `available` / `version` / `updatedAt`) plus the cross-location `totalOnHand` and
  `totalAvailable`. It is keyed on `variantId`.

Both the **value shape** and the **id axis** moved (product → variant). Either
alone would justify a bump; together they make the old and new entries entirely
incompatible. So `INVENTORY_STOCK_KEY_VERSION` goes `'v1' → 'v2'` in
[`libs/cache/cache-keys.ts`](../../../libs/cache/cache-keys.ts) — a one-line edit,
because the version segment is a **constant next to the builder**, never a builder
argument (ADR-022). That keeps the live version greppable and makes the bump a
single reviewable line.

## The new key shape

```
ris:[t:<tenantId>:]inventory:stock:v2:<variantId>:<facet>
```

- `ris:` is the global root; `t:<tenantId>:` is the **opt-in** tenant segment —
  omitted entirely in single-tenant mode, never defaulted to `t:default:`
  (ADR-022).
- `inventory:stock` is `<service>:<aggregate>`.
- `v2` is the schema version.
- `<variantId>` is the id axis — the catalog variant, the downstream backbone key
  ([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md) /
  [ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)).
- `<facet>` is either the non-glob sentinel `__all__` (every location) or a sorted
  (`localeCompare`) comma-joined set of stock-location ids when the read is scoped
  to a subset.

Examples:

```
ris:inventory:stock:v2:42:__all__                          # variant 42, every location
ris:inventory:stock:v2:42:head-warehouse,west-warehouse    # a two-location subset
ris:t:store-7:inventory:stock:v2:42:__all__                # tenant store-7
```

The `inventoryStockPrefix(variantId)` builder returns everything up to and
including the trailing `:` before the facet, so a prefix delete wipes **every**
facet (all-locations and any subset) for one variant in a single call.

## The four coexisting key families

Because all services deploy together and no production data exists, this is a
clean cut — but the invalidate path is still written to wipe the historical
shapes during the rolling-deploy transition window, so a stale in-flight entry
from any prior shape cannot survive the first post-deploy write. There are now
**four** families the invalidate fan-out covers, one current and three
invalidate-only:

| Family | Prefix builder | Shape | Role |
| --- | --- | --- | --- |
| Current (`v2`) | `inventoryStockPrefix` | `ris:[t:…:]inventory:stock:v2:<variantId>:` | read + write |
| Pre-`v2` (`v1`) | `inventoryStockLegacyPrefixV1` | `ris:inventory:stock:v1:<id>:` | invalidate-only |
| Pre-`v1` (post-ADR-016) | `inventoryStockLegacyPrefix` | `ris:inventory:stock:<id>:` | invalidate-only |
| Pre-ADR-016 legacy | `productStockPrefix` | `stock:<productId>:` | invalidate-only |

Only the current `v2` builder is used for reads and writes. The three legacy
builders exist **solely** so the write path's invalidate fan-out
(`StockCache.withInvalidation` → the private `invalidatePrefixes`) can `delByPrefix`
each of them per affected `variantId`. The `v1` family keyed the **old**
`productId` axis; we wipe it by the now-`variantId` numeric id, which is
sufficient for the transition window precisely because there is no production data
whose product/variant id spaces would diverge in a way that matters.

The three legacy wipes are unconditionally **single-tenant**: the `v1`, pre-`v1`,
and pre-ADR-016 shapes never carried a tenant segment, so there is nothing to
scope. Only the current `v2` wipe threads the supplied `tenantId`.

> The write/invalidate path itself (`withInvalidation`) ships in this change so it
> is ready for the Receive / Adjust write operations that consume it; this read
> path does not invalidate (reads never mutate). See
> [ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) for why
> invalidation is reachable only through `withInvalidation` and never a public
> `invalidate`.

## What happens to the `v1` entries on Redis

Nothing is bulk-deleted at deploy time. After the bump:

- Any `v1`-prefixed entry already on Redis (`ris:inventory:stock:v1:<id>:…`)
  becomes **unreachable on the read path** — the new code only ever computes `v2`
  keys, so it never looks the `v1` key up again.
- Those orphaned entries **age out via their TTL** (the safety-net TTL is the
  backstop; ADR-002). They occupy memory until expiry but are never served.
- During the transition window, the first write that touches a given `variantId`
  also wipes the `v1` (and pre-`v1`, pre-ADR-016) prefixes for that id via the
  invalidate fan-out, so correlated stale entries are cleared early rather than
  waiting for TTL.

This is the designed behaviour of a version bump: re-key, let the old slots
expire, optionally sweep them on the next write. No cache migration job runs.

## What did *not* change: the cache mechanism

Only the **value shape** and the **key version** moved. The caching *mechanism* is
untouched:

- **Cache-aside** (read-through on miss, write-back, TTL safety net) —
  [ADR-002](../../adr/002-redis-cache-aside-product-stock.md) /
  [ADR-006](../../adr/006-cache-aside-via-libs-cache.md).
- **The `ris:…` key convention + `delByPrefix` invalidation** —
  [ADR-016](../../adr/016-cache-aside-generalized.md).
- **Single-flight miss-dedupe + ±10% TTL jitter** on the write-back —
  [ADR-021](../../adr/021-cache-single-flight-and-ttl-jitter.md). The read use
  case calls `stockCache.getOrLoad(payload, loader)` and never composes
  `get → loader → set` by hand.
- **Post-commit, type-enforced invalidation** (`withInvalidation`, no public
  `invalidate`) — [ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md).

The domain-shaped `IStockCachePort` still hides the key string from the use cases;
the only thing a reader of `QueryAvailabilityUseCase` sees is "ask the cache,
fall back to the repository". A Redis outage degrades latency, never correctness:
a read that fails returns `available: false`, the use case serves the value from
the repository, and the write-back is skipped (CACHE-005).

See [07-availability-read-path.md](07-availability-read-path.md) for the read use
case, the RPC handlers, and the contract DTOs that consume this cache, and
[ADR-022](../../adr/022-cache-keys-tenant-and-schema-version.md) for the
schema-version rule this bump follows.
