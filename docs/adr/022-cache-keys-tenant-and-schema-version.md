# ADR-022: Cache-key schema-version and opt-in tenant segments

- **Date**: 2026-05-20
- **Status**: Accepted (port-surface mention superseded in part by ADR-023; see References)

---

## Context

[ADR-002](002-redis-cache-aside-product-stock.md) introduced the cache-aside
contract for product-stock queries; [ADR-006](006-cache-aside-via-libs-cache.md)
moved it behind the generic `ICachePort`; [ADR-016](016-cache-aside-generalized.md)
centralised the `CACHE_KEYS` registry under the
`ris:<service>:<aggregate>:<id>[:<facet>]` shape and added the
`delByPrefix` invalidation primitive; [ADR-021](021-cache-single-flight-and-ttl-jitter.md)
added in-process single-flight and ±10% TTL jitter.

Two latent key-shape gaps remained after ADR-016. Both are explicitly
called out in the `cache-keys.ts` header comment as open, and both are
re-confirmed by the
[2026-05-20 follow-up audit](../audits/audit-2026-05-20-followup.md):

- **CACHE-003 — no schema-version segment in keys.** Cache reads in
  `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
  use only a TypeScript generic assertion
  (`cache.get<ProductStockGetResponseDto>(cacheKey)`). A breaking change
  to `ProductStockGetResponseDto` would deserialize in-flight cached
  entries against the new shape for one TTL window — silently mismatched
  fields, no runtime validation. There is nothing in the key telling a
  reader which DTO shape produced the cached value.

- **CACHE-009 — no tenant segment.** The current builders emit
  `ris:inventory:stock:<productId>:<facet>` with no tenant identifier.
  The project has no multi-tenant model today, so the bug is latent —
  but once introduced, two tenants holding the same `productId` would
  read each other's cached stock. That is a correctness *and* a
  data-leak risk, not just a collision.

Both are key-shape changes that ripple through every reader, writer,
and invalidator. Bundling them keeps the invalidation transition window
short (one rolling deploy for both segments, not two).

## Decision

The current cache-key shape becomes:

```
ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]
```

Implemented by extending the `CACHE_KEYS` registry in
[`libs/cache/cache-keys.ts`](../../libs/cache/cache-keys.ts):

```ts
const INVENTORY_STOCK_KEY_VERSION = 'v1';
const RETAIL_ORDER_KEY_VERSION = 'v1';

inventoryStockPrefix: (productId, opts?: { tenantId?: string }) =>
  `${rootPrefix(opts)}inventory:stock:${INVENTORY_STOCK_KEY_VERSION}:${productId}:`;

inventoryStock: (productId, storageIds?, opts?: { tenantId?: string }) =>
  `${inventoryStockPrefix(productId, opts)}${facet(storageIds)}`;
```

`rootPrefix(opts)` returns `ris:t:<tenantId>:` when `opts.tenantId` is
supplied, otherwise `ris:`.

### 1. Segment order — tenant near root, version near aggregate

Chosen order:
`ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`.

Reasons:

- **SCAN-by-tenant is a tight prefix wipe.** Operational scenarios that
  need "drop every cached value for tenant X" (tenant offboarding,
  per-tenant cache bust, GDPR/right-to-erasure) become a single
  `delByPrefix('ris:t:<tenantId>:')`. Pushing the tenant segment near
  the id would force a SCAN across every service/aggregate combination.
- **The version segment groups with the aggregate it scopes.** Each
  aggregate has its own DTO lifecycle, so the version constant is
  per-aggregate (`INVENTORY_STOCK_KEY_VERSION`, `RETAIL_ORDER_KEY_VERSION`).
  Putting the version segment between `<aggregate>` and `<id>` keeps
  the visual grouping consistent with how the constant is owned in
  source.
- **Operator readability.** Reading a key right-to-left, you see
  `<facet>` (what), `<id>` (which entity), `<version>` (shape epoch),
  `<aggregate>` (which port owns it), `<service>` (which app), and
  optionally `t:<tenantId>` (which tenant). That is the order a human
  inspects when chasing a cache bug.

The rejected alternative
(`ris:<service>:<aggregate>:<version>:t:<tenantId>:<id>:<facet>` — version
closest to aggregate, tenant near the id) keeps version + aggregate
together but makes SCAN-by-tenant fan out across every aggregate.

### 2. Version is a required, per-aggregate constant

The version segment is **part of the key** — not an optional argument.
The constant lives next to the builder
(`const INVENTORY_STOCK_KEY_VERSION = 'v1'`) so bumping it is a
one-line edit. The builder does not take a `version` argument — that
would push the bump complexity to every call site and make it
impossible to grep for the live version.

**Version-bump procedure.** When a breaking DTO shape change ships:

1. Bump the relevant constant (`v1` → `v2`) in `cache-keys.ts`.
2. Deploy. Every new read/write goes to the v2 prefix; v1 entries become
   unreachable from production code.
3. v1 entries age out via TTL (default 60s for stock). No SCAN+UNLINK
   needed for the version bump itself — the new builder simply does not
   touch the old keyspace.

The `StockCache.invalidate` path also wipes the pre-bump shape (see §4)
so that a *concurrent* write right after the bump cuts every stale
entry for the mutated id immediately, rather than waiting for TTL.

### 3. Tenant is opt-in by argument, never defaulted

The tenant segment is **optional**. Builders accept
`opts?: { tenantId?: string }`. A missing `tenantId` means
single-tenant mode and the segment is omitted entirely.

Specifically rejected: defaulting to `'default'` (i.e.
`ris:t:default:inventory:...`). Reasons:

- A future migration from single-tenant to multi-tenant should be a
  *deliberate* re-keying event, not a silent inheritance.
  `ris:t:default:...` would let the migration ship without anyone
  noticing every old entry is now scoped to a tenant that never
  existed in the domain.
- The shape difference between "no tenant" and "tenant supplied" is
  load-bearing: it forces the call site to think about whether the
  read is genuinely cross-tenant or accidentally so. A defaulted
  tenant erases that distinction.

The stock-cache port (`IStockCacheGetPayload`, `IStockCacheSetPayload`,
`IStockCacheInvalidatePayload`) carries an optional `tenantId` field
today. Inventory use cases do not populate it — there is no tenant
model in the domain yet — but the port surface is ready, so a future
migration is a wiring change, not a contract change.

### 4. Transition window for pre-v1 entries

A second transition window is layered on top of the existing ADR-016
one. `StockCache.invalidate` now fans out three `delByPrefix` calls
per productId:

1. **v1 prefix** — `ris:[t:<tenantId>:]inventory:stock:v1:<productId>:`.
   The live shape; wipes every facet for the id under the supplied
   tenant.
2. **Pre-v1 (post-ADR-016) prefix** — `ris:inventory:stock:<productId>:`.
   Exposed as `CACHE_KEYS.inventoryStockLegacyPrefix` and used **only**
   by `invalidate`. Wipes in-flight entries from before the v1 cut-over
   so a rolling deploy does not leave stale-shape entries that survive
   past TTL. Unconditionally single-tenant — the pre-v1 shape never
   carried a tenant segment, so there is nothing to scope.
3. **Pre-ADR-016 legacy prefix** — `stock:<productId>:`. The original
   ADR-016 transition prefix; still wiped on every invalidate so the
   first post-deploy write evicts any entry written under the original
   convention. Single-tenant by construction.

The transition window for the v1 cut-over is **one rolling deploy**.
After the slowest replica has restarted onto v1 and at least one
invalidate has fired for each affected `productId`, the pre-v1 prefix
is unreachable from production code; any remaining entries age out
via TTL. The pre-v1 fan-out can be removed in a follow-up task once
the dashboards confirm zero pre-v1 hits.

### 5. Retail-side parity

`CACHE_KEYS.retailOrder` and `CACHE_KEYS.retailOrderPrefix` gain the
same `version` + opt-in `tenantId` shape:

```
ris:[t:<tenantId>:]retail:order:v1:<orderId>:[__all__|<facet>]
```

The retail microservice does not actively cache today (verified by
grep) — but the builder contract is consistent, so future retail-cache
work does not re-litigate the shape. No retail-side invalidate path
exists yet; one will be added when the first retail cache consumer
ships.

## Alternatives Considered

1. **Schema version as an optional builder argument**
   (`inventoryStock(productId, storageIds, { version: 'v2' })`).
   Rejected. The version is a property of the *cache layout*, not of
   the call. A per-call argument would force every reader and writer
   to track and pass it correctly; one typo and the cache silently
   bifurcates. The constant-next-to-builder pattern keeps the live
   version unambiguous and greppable.

2. **Defaulted tenant (`ris:t:default:...`)**. Rejected (see §3). The
   silent-inheritance failure mode dominates the marginal symmetry
   benefit.

3. **Single ADR for tenant only, schema version later**. Rejected. Both
   are key-shape changes. Bundling them keeps the rolling-deploy
   transition window short (one cut-over, three prefixes wiped per
   invalidate) rather than two consecutive cut-overs with two
   overlapping transition windows.

4. **Runtime DTO validation on cache read instead of a version segment**.
   Considered. Would catch shape mismatches at deserialize-time using
   `class-validator` against `ProductStockGetResponseDto`. Held back as
   complementary, not a substitute: validation tells you *that* an
   entry is wrong (and forces a fall-through to the DB), while the
   version segment tells you *which* entries are unreachable and lets
   them die quietly via TTL. A future ADR can add validation on top of
   the version segment without re-shaping the key.

5. **Hash-based version segment** (e.g. first 8 chars of a hash over
   the DTO interface). Considered. Self-updates without manual edits,
   but loses the human-readable `v1`/`v2` semantics and makes
   intentional cache busts (without a DTO change) impossible. The
   manual constant is simpler.

## Consequences

### Positive

- **CACHE-003 closed.** Every cached value is keyed under an explicit
  shape version; a DTO bump becomes one constant edit, with the old
  entries unreachable on deploy.
- **CACHE-009 closed in the builder surface.** The tenant segment is
  available now; activating it is a use-case-side change once a tenant
  model exists.
- **Operational tenant wipe** is `delByPrefix('ris:t:<tenantId>:')` —
  no SCAN fan-out across services. Easy GDPR / offboarding story.
- **One transition window, three prefixes.** The rolling deploy that
  ships this ADR is the only deploy that needs the pre-v1 fan-out.
  Subsequent deploys carry the same three calls until the cleanup task
  removes the pre-v1 entry; the runtime cost is one extra no-op SCAN
  per productId per invalidate, paid once per confirm RPC.
- **Per-aggregate version constants** decouple shape evolution: bumping
  `INVENTORY_STOCK_KEY_VERSION` does not touch retail; bumping
  `RETAIL_ORDER_KEY_VERSION` does not touch inventory.

### Negative / Costs

- **Three `delByPrefix` calls per productId per invalidate** during the
  transition window (vs two before). The extra cost is one no-op SCAN
  per productId — small in absolute terms but worth removing in the
  follow-up cleanup task once dashboards confirm no pre-v1 hits.
- **Tenant segment is dormant.** Until a domain-level tenant model
  exists, the segment is always absent in production. The plumbing
  cost (port field, builder argument) is paid up front.
- **No runtime validation yet.** A bad version constant (e.g. someone
  reverts the bump but the DTO change ships) would silently rehash
  entries under the wrong shape. Mitigated by code review and the
  audit's existing "version-bump procedure" callout.

### Neutral / Follow-ups

- **Follow-up:** remove the pre-v1 `inventoryStockLegacyPrefix` wipe
  from `StockCache.invalidate` once dashboards (TBD instrumentation —
  hits-per-prefix counter) show zero hits for one full TTL.
- **Follow-up:** add runtime DTO validation on cache read for the stock
  aggregate — complementary to the version segment, not a replacement.
- **Follow-up:** thread `tenantId` from the gateway / RPC payload into
  the stock use cases once a tenant model lands. The port already
  accepts it.

## References

- Source audit: [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md)
- Original audit: [`docs/audits/audit-2026-05-08.md`](../audits/audit-2026-05-08.md)
- Prior ADRs in the cache lineage: [ADR-002](002-redis-cache-aside-product-stock.md),
  [ADR-006](006-cache-aside-via-libs-cache.md),
  [ADR-016](016-cache-aside-generalized.md),
  [ADR-021](021-cache-single-flight-and-ttl-jitter.md)
- Successor in the cache lineage:
  [ADR-023](023-cache-invalidate-post-commit-by-type.md) — retires the public
  `IStockCacheInvalidatePayload` referenced in §"3. Tenant is opt-in by
  argument, never defaulted"; the optional `tenantId` field now lives on the
  `IStockWithInvalidationOptions` interface that
  `IStockCachePort.withInvalidation(work, resolveItems, opts)` accepts.
  ADR-022's per-aggregate schema-version segment and opt-in tenant segment are
  unchanged; only the type that carries the tenant on the invalidate path
  moved.
