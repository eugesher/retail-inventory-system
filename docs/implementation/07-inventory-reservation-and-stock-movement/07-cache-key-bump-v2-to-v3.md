# Stock cache key bump `v2 → v3`

The inventory availability read is cache-aside over Redis: a `VariantStockView`
(per-location `StockLevelView` rows + cross-location totals) is cached under

```
ris:[t:<tenantId>:]inventory:stock:<version>:<variantId>:<facet>
```

where `<version>` is a per-aggregate schema-version constant
(`INVENTORY_STOCK_KEY_VERSION` in [`libs/cache/cache-keys.ts`](../../../libs/cache/cache-keys.ts)).
This note records why that constant moved from `v2` to `v3` when stock
reservations went live.

Related decisions: [ADR-022](../../adr/022-cache-keys-tenant-and-schema-version.md)
(the version-segment bump mechanism), [ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) §7
(the bump rationale), [ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md)
(post-commit invalidation, unchanged here).

## A semantic change with no field change

ADR-022's rule is that the version segment is bumped on a **breaking change to the
cached value** — and that "breaking" is about **value semantics, not just the
field set**. This bump is the textbook case the rule was written for:

- The previous bump `v1 → v2` was a *shape* change — the cached value reshaped from
  a per-product `SUM`/`GROUP BY` aggregate keyed on `productId` to a per-variant
  `VariantStockView` projection keyed on `variantId` (ADR-027). New fields, new key
  axis: obviously breaking.
- This bump `v2 → v3` changes **no field**. `VariantStockView` carries the same
  `quantityOnHand` / `quantityAllocated` / `quantityReserved` / `available` it
  always did. What changes is what one of those fields *means*: once TTL-bounded
  reservations move `quantityReserved`, `available` reflects **holds** that did not
  exist before. A reader still running the `v2` code would treat a held unit
  exactly as it treated stock before holds existed — it would over-report
  `available`. The bytes look the same; the meaning is different.

Bumping the version is the correct response precisely because the field set is
unchanged: there is no structural signal (a missing field, a type error) that would
otherwise protect a stale reader. The version segment is that signal.

## The one-line bump

The change is a single constant edit:

```ts
// libs/cache/cache-keys.ts
const INVENTORY_STOCK_KEY_VERSION = 'v3'; // was 'v2'
```

Every reader and writer composes its key through `CACHE_KEYS.inventoryStock(...)` /
`CACHE_KEYS.inventoryStockPrefix(...)`, so flipping the constant re-keys the whole
aggregate at once. Entries written under the old `v2` key become unreachable —
nothing reads `…:v2:…` anymore — and age out of Redis via their TTL. No production
data exists, and the cache is a latency optimization over MySQL (the source of
truth), so an orphaned `v2` entry is at worst a one-TTL miss, never a correctness
problem.

## The new legacy prefix in a five-family fan-out

A rolling deploy can leave in-flight `v2` entries written by an old replica moments
before the bump. To wipe those promptly rather than waiting out their TTL, the
write-path invalidation fans out across **every** historical key family. A new
invalidate-only builder was added:

```ts
// libs/cache/cache-keys.ts
inventoryStockLegacyPrefixV2: (id: number): string => `ris:inventory:stock:v2:${id}:`,
```

It is exposed **solely** for the transition-window wipe — reads and writes use the
current `v3` builders. `StockCache.invalidatePrefixes` now issues **five**
`delByPrefix` calls per affected `variantId`:

| Prefix builder | Shape | Role |
|---|---|---|
| `inventoryStockPrefix` | `ris:[t:…:]inventory:stock:v3:<id>:` | current (tenant-aware) |
| `inventoryStockLegacyPrefixV2` | `ris:inventory:stock:v2:<id>:` | pre-v3 (this bump) |
| `inventoryStockLegacyPrefixV1` | `ris:inventory:stock:v1:<id>:` | pre-v2 |
| `inventoryStockLegacyPrefix` | `ris:inventory:stock:<id>:` | pre-v1 (no version) |
| `productStockPrefix` | `stock:<id>:` | pre-ADR-016 |

Only the current `v3` family carries the opt-in `t:<tenantId>:` segment; the four
legacy shapes are wiped tenant-agnostically (the older shapes never carried a tenant
segment, and the `v2` legacy builder takes only the id). Each `delByPrefix` runs
`SCAN MATCH <prefix>*` + `UNLINK`, so the fan-out is bounded and non-blocking on
Redis's main thread.

## Verification

After deploying the bump, confirm reads/writes land on `v3` and no code writes `v2`:

```bash
# Current-shape entries appear under v3 after a read primes them:
redis-cli --scan --pattern 'ris:inventory:stock:v3:*'

# No NEW v2 entries should appear after the deploy (a few may linger from
# in-flight pre-deploy writes until the next invalidate or their TTL):
redis-cli --scan --pattern 'ris:inventory:stock:v2:*'

# Inspect a specific variant's cached availability + its remaining TTL:
redis-cli GET  'ris:inventory:stock:v3:1:__all__'
redis-cli PTTL 'ris:inventory:stock:v3:1:__all__'
```

The literal `v3` is asserted as a regression boundary in
[`libs/cache/spec/cache-keys.spec.ts`](../../../libs/cache/spec/cache-keys.spec.ts),
the stock cache adapter spec, and the inventory cache e2e suite — a future bump
trips those specs until the constant and the literals agree again.
