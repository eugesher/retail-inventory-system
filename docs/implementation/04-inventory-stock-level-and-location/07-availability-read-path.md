# The inventory availability read path

This document describes how a caller reads stock availability out of the system:
the two HTTP endpoints the API gateway exposes, the RPCs and use cases behind
them, the cache-aside mechanism that backs the per-variant read, the response
shape, and the seed that guarantees a real figure before any inventory consumer
has run. It builds on the new inventory model — per-location
[`StockLevel` running totals](03-stocklevel-aggregate-and-version-column.md)
keyed on the catalog **variant**, and a first-class
[`StockLocation`](02-default-stocklocation-auto-provision.md) — and on the
[`v1 → v2` cache-key bump](04-cache-key-bump-v1-to-v2.md) that records the new
cached-value shape.

## Two read endpoints, two different gates

The gateway `inventory` module
(`apps/api-gateway/src/modules/inventory/`) fronts the inventory microservice's
two read RPCs over HTTP at `/api/inventory`. It is a thin port-and-adapter module
named after the downstream service, not the URL prefix
([ADR-009](../../adr/009-port-adapter-at-the-gateway.md)): the controller and the
two use cases depend on `INVENTORY_GATEWAY_PORT`, and only
`InventoryRabbitmqAdapter` (under `infrastructure/messaging/`) holds a
`ClientProxy`.

| Route | Auth | RPC | Returns |
| ----- | ---- | --- | ------- |
| `GET /api/inventory/variants/:variantId/stock` | `@Public()` | `inventory.stock-level.get` | `VariantStockView` |
| `GET /api/inventory/locations` | `@RequiresPermission(inventory:read)` | `inventory.location.list` | `StockLocationView[]` |

The two gates differ on purpose
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)):

- **The per-variant availability read is public.** An unauthenticated shopper
  needs to see whether an item is in stock before deciding to check out, so the
  route carries `@Public()` and serves anyone.
- **The location list is staff-only.** The set of warehouses/stores is
  operational data, so the route requires the `inventory:read` permission code.
  Because customer tokens carry no `permissions` claim, a code-gated route is
  staff-only by construction — there is no separate "is this a staff user" check
  to maintain.

A request with no token to `GET /api/inventory/locations` is rejected by the
global `JwtAuthGuard` with `401`; a customer or under-privileged staff token is
rejected by the `PermissionsGuard` with `403`.

## The response shape: `VariantStockView`

The variant-stock read answers with a `VariantStockView`
(`libs/contracts/inventory/stock/`):

```jsonc
{
  "variantId": 1,
  "totalOnHand": 100,
  "totalAvailable": 100,
  "locations": [
    {
      "stockLocationId": "default-warehouse",
      "quantityOnHand": 100,
      "quantityAllocated": 0,
      "quantityReserved": 0,
      "available": 100,
      "version": 0,
      "updatedAt": "2026-06-08T12:00:00.000Z"
    }
  ]
}
```

Each `locations[]` entry is one `StockLevelView` — the projection of a single
`stock_level` row. `available` is the derived sellable count
(`quantityOnHand − quantityAllocated − quantityReserved`), computed by the domain
getter and projected onto the view (never stored). The two totals are the
cross-location aggregate: `totalOnHand` sums each location's `quantityOnHand`, and
`totalAvailable` sums each location's derived `available`. The read use case sorts
`locations` by `stockLocationId` so the projection — and therefore the cached
value — is deterministic for a given database state.

An **empty `locations` array is a valid answer**: a variant with no `stock_level`
rows for the requested scope is "zero available everywhere", not an error. The
public read returns `200` with `totalOnHand: 0`, `totalAvailable: 0`,
`locations: []` rather than a `404`. This keeps availability a total function —
every variant id has an answer.

## Per-location vs aggregated reads

The variant-stock route accepts an optional `?locationIds` query, encoded as a
**comma-separated list** (`?locationIds=default-warehouse,backup-store`). A small
`VariantStockQueryDto` normalizes it into a `string[]` and tolerates the
repeated-parameter form too.

- **Omit `?locationIds`** to aggregate across *every* location. This is the
  default a shopper-facing "is it in stock anywhere?" question wants.
- **Pass a subset** to scope the answer to those locations only. The totals then
  cover just the requested locations.

The omit-to-aggregate default has a write-side mirror (not yet exposed over HTTP):
`default-warehouse` is the implicit target a stock write defaults to when its body
names no location. The migration provisions exactly one such default location, so
there is always a location to read from and write to.

## Cache-aside on the per-variant read

The variant-stock read is cached with Redis cache-aside
([ADR-002](../../adr/002-redis-cache-aside-product-stock.md)); the location list
is not (a small, slow-changing set). The mechanism is unchanged from the prior
inventory model — only the cached *value shape* changed, which is what forced the
[`v1 → v2` key-version bump](04-cache-key-bump-v1-to-v2.md). The cached value is
the `VariantStockView`, stored under

```
ris:inventory:stock:v2:<variantId>:<facet>
```

where `<facet>` is the sorted, comma-joined location scope, or the `__all__`
sentinel when unscoped.

The read use case (`QueryAvailabilityUseCase`, in the inventory microservice)
composes the whole cache-aside dance through one `stockCache.getOrLoad(...)` call:

1. **Read-through on miss.** On a cache miss the loader runs a point lookup of the
   variant's `stock_level` rows, projects each onto a `StockLevelView`, sorts, and
   aggregates the totals. A point lookup of running totals replaces the old
   `SUM/GROUP BY` re-aggregation that grew with ledger history.
2. **Write-back.** The helper writes the loaded `VariantStockView` back under the
   key with a ±10% jittered TTL (so a fleet of keys does not expire in lockstep),
   behind an in-process single-flight (so a stampede of concurrent misses for the
   same key runs the loader once).
3. **Hit.** A subsequent identical read returns the cached value without touching
   MySQL. Because the cached value is deterministic, the second response is
   byte-equal to the first.

Even a zero-availability answer (`locations: []`) is cached — "this variant has no
stock" is as cacheable as any other answer, and caching it avoids re-querying for
absent rows.

**Reads never invalidate.** Cache invalidation is a write-path concern: a stock
write wraps its transaction in the cache's `withInvalidation(...)` helper, which
awaits the commit and *then* deletes the affected key prefixes — post-commit
ordering is enforced by the type system
([ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md)), so it cannot
run before the data is durable. There is no write endpoint in this read path; the
read use case has no transactional/skip-cache branch because it never holds a
caller-owned transaction scope.

If Redis is unavailable, the read degrades to a direct database load and logs one
warning — a cache outage costs latency, never correctness.

## A seed so the read returns a real figure immediately

`GET /api/inventory/variants/:variantId/stock` is only interesting if there is
stock to read. On the live system a `stock_level` row is auto-initialized when a
catalog variant is created; but `yarn test:seed` can run before any RabbitMQ
consumer is up, so it cannot rely on that path. To make the read meaningful from a
cold seed, `scripts/seeds/stock-level.sql` inserts one `stock_level` row per
seeded catalog variant (ids `1..4`), 100 on hand at `default-warehouse`, with
allocated/reserved at 0 (so `available = 100`) and `version` 0. It is idempotent
(`INSERT IGNORE` on the `UNIQUE (variant_id, stock_location_id)` key), so
re-seeding never errors or double-counts. It is registered in
`scripts/utils/test-db-seed.util.ts` **after** `catalog-product-variant.sql`
because `stock_level.variant_id` is a foreign key to `product_variant.id`; the
`default-warehouse` location it references comes from the migration, not a seed.

The result: straight after a seed, the public read of variant 1 returns
`totalOnHand: 100`, `totalAvailable: 100`, and one `default-warehouse` entry —
exactly what the auto-initialize-then-receive path would have produced.

## How to verify

With the stack and a fresh seed up (`docker compose up -d`, `yarn migration:run`,
`yarn test:seed`, `yarn start:dev`):

```bash
# Public variant-stock read — no Authorization header (100 on hand at default-warehouse)
curl -s http://localhost:3000/api/inventory/variants/1/stock | jq

# Same read again, then confirm the cache key landed in Redis
redis-cli --scan 'ris:inventory:stock:v2:*'
#   ris:inventory:stock:v2:1:__all__

# Location list — 401 without a token, 200 with a staff bearer (admin or warehouse-staff)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/inventory/locations   # 401
```

The `http/inventory.http` requests (`listLocations`, `getVariantStockAllLocations`,
`getVariantStockFiltered`) drive the same calls from an editor, and
`test/inventory-availability.e2e-spec.ts` asserts the public read, the
miss-then-hit equality, the `401`/`200` on the location list, and the
zero-availability answer for a variant with no rows.
