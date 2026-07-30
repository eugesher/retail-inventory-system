# Inventory stock cache: the `v1 → v2` key-version bump

The inventory availability read path is cached with Redis cache-aside. When the
inventory model moved from an append-only per-product ledger to per-location
running totals keyed on the catalog **variant**
([03-stocklevel-aggregate-and-version-column.md](03-stocklevel-aggregate-and-version-column.md)),
the **shape of the cached value changed**. Under the per-aggregate cache-key
schema-version rule ([ADR-022](../../adr/022-cache-keys-tenant-and-schema-version.md)),
a breaking change to a cached value's shape is recorded by bumping that
aggregate's version constant. This document explains the bump from `v1` to `v2`,
the new key shape, the key families that coexist (four at epic time, five today), and
what happens to the old entries.

> **Since this epic, the live version has moved again — it is `v3` today, not `v2`.**
> The reservation-and-movement capability
> ([ADR-030 §7](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md))
> bumped `v2 → v3` when reservations began moving `quantityReserved`: the cached
> `VariantStockView` changed *semantically* even though its field set did not (the
> ADR-022 rule covers value semantics, not only shape). And the legacy-prefix **sweep**
> this document describes has since been **removed** (ISSUE-03 / commit `79b111a`;
> [ADR-053](../../adr/053-how-a-transition-window-closes.md)): the write path now wipes
> **exactly one** prefix — the live version's — and the retired shapes are read by
> nothing, written by nothing, and swept by nothing. The `v1 → v2` narrative below is
> the bump *as it shipped in this epic* and remains a faithful worked example of the
> version-bump mechanism; the paragraphs that assert `v2` is live or that the fan-out
> sweeps the old prefixes are corrected inline where they occur.

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
incompatible. So `INVENTORY_STOCK_KEY_VERSION` went `'v1' → 'v2'` in
[`libs/cache/cache-keys.ts`](../../../libs/cache/cache-keys.ts) — a one-line edit,
because the version segment is a **constant next to the builder**, never a builder
argument (ADR-022). That keeps the live version greppable and makes the bump a
single reviewable line. (The same one-line mechanism carried the later `'v2' → 'v3'`
bump; the constant reads `'v3'` today — see the note at the top.)

## The new key shape

(The version segment was `v2` when this epic shipped and is `v3` today — the shape is
otherwise identical, only the token differs. It is shown below as `v3`, the value a reader
actually finds in Redis.)

```
ris:[t:<tenantId>:]inventory:stock:v3:<variantId>:<facet>
```

- `ris:` is the global root; `t:<tenantId>:` is the **opt-in** tenant segment —
  omitted entirely in single-tenant mode, never defaulted to `t:default:`
  (ADR-022).
- `inventory:stock` is `<service>:<aggregate>`.
- `v3` is the schema version (it was `v2` at epic time).
- `<variantId>` is the id axis — the catalog variant, the downstream backbone key
  ([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md) /
  [ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)).
- `<facet>` is either the non-glob sentinel `__all__` (every location) or a sorted
  (`localeCompare`) comma-joined set of stock-location ids when the read is scoped
  to a subset.

Examples:

```
ris:inventory:stock:v3:42:__all__                          # variant 42, every location
ris:inventory:stock:v3:42:head-warehouse,west-warehouse    # a two-location subset
ris:t:store-7:inventory:stock:v3:42:__all__                # tenant store-7
```

The `inventoryStockPrefix(variantId)` builder returns everything up to and
including the trailing `:` before the facet, so a prefix delete wipes **every**
facet (all-locations and any subset) for one variant in a single call.

## The coexisting key families

At epic time this shipped as **four** families the invalidate fan-out covered — one
current (`v2`) and three invalidate-only — on the reasoning that a rolling deploy across
the bump must not serve an entry a previous key version had written. **That is no longer
how it works** (ISSUE-03; see the top note): there is now a fifth retired shape (`v2`
itself, demoted when `v3` went live), and the fan-out sweep has been **removed entirely**
— the write path deletes only the live version's prefix. The table below is kept as the
registry of every shape this aggregate's key has ever had, with each row's *current* role:

| Family                  | Prefix builder                 | Shape                                       | Role today                                     |
|-------------------------|--------------------------------|---------------------------------------------|------------------------------------------------|
| Current (`v3`)          | `inventoryStockPrefix`         | `ris:[t:…:]inventory:stock:v3:<variantId>:` | read + write + the one prefix wiped on a write |
| Pre-`v3` (`v2`)         | `inventoryStockLegacyPrefixV2` | `ris:inventory:stock:v2:<id>:`              | retired — no caller                            |
| Pre-`v2` (`v1`)         | `inventoryStockLegacyPrefixV1` | `ris:inventory:stock:v1:<id>:`              | retired — no caller                            |
| Pre-`v1` (post-ADR-016) | `inventoryStockLegacyPrefix`   | `ris:inventory:stock:<id>:`                 | retired — no caller                            |
| Pre-ADR-016 legacy      | `productStockPrefix`           | `stock:<productId>:`                        | retired — no caller                            |

Only the current `v3` builder is used for reads and writes, **and it is the only prefix
the write path wipes** (`StockCache.withInvalidation` → the private `invalidatePrefixes`,
one `delByPrefix` per affected `variantId`, threading the supplied `tenantId` — ADR-022).
The four retired builders survive in
[`libs/cache/cache-keys.ts`](../../../libs/cache/cache-keys.ts) as a **registry** of what
each bump changed — read by nothing, written by nothing, swept by nothing
([ADR-046](../../adr/046-libs-layout-and-dead-export-removal.md): *"one line in a registry,
where being a complete registry is the point"*). They could never have mattered even while
the sweep ran: there is deliberately no full-key builder for a retired shape, so an entry
under one is unreachable garbage that ages out on its own TTL. The `v1` family keyed the
**old** `productId` axis and the builders take the now-`variantId` numeric id — a mismatch
that never mattered, because the project has never deployed and no Redis holds a key in any
retired shape.

> The write/invalidate path itself (`withInvalidation`) ships in this change so it
> is ready for the Receive / Adjust write operations that consume it; this read
> path does not invalidate (reads never mutate). See
> [ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) for why
> invalidation is reachable only through `withInvalidation` and never a public
> `invalidate`.

## What happens to the `v1` entries on Redis

Nothing is bulk-deleted at deploy time. After the bump:

- Any `v1`-prefixed entry already on Redis (`ris:inventory:stock:v1:<id>:…`)
  becomes **unreachable on the read path** — the live code only ever computes the
  current version's keys (`v2` at epic time, `v3` today), so it never looks the `v1`
  key up again.
- Those orphaned entries **age out via their TTL** (the safety-net TTL is the
  backstop; ADR-002). They occupy memory until expiry but are never served.
- At epic time, the first write touching a given `variantId` also swept the `v1`
  (and pre-`v1`, pre-ADR-016) prefixes via the invalidate fan-out. **That sweep has
  since been removed** (ISSUE-03): the write path now wipes only the live prefix, and
  every retired shape ages out purely on its TTL. Because the project has never
  deployed, no such entry has ever actually existed to age out.

This is the designed behaviour of a version bump: re-key and let the old slots
expire. No cache migration job runs.

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
