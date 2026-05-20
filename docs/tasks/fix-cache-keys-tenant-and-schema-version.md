# fix — cache-key schema-version and tenant segments

> Paste this entire file as the first user message in a Claude Code (Opus)
> session opened at the project root of `retail-inventory-system`. Do not
> add anything else.

## Conventions

This task inherits the rules in
[`docs/tasks/CONVENTIONS.md`](CONVENTIONS.md). Read it before starting.

## Context

- Source audit: [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md)
- Issues addressed: **CACHE-003**, **CACHE-009**
- Original audit (historical): [`docs/audits/audit-2026-05-08.md`](../audits/audit-2026-05-08.md)
- Relevant ADRs: [ADR-002](../adr/002-redis-cache-aside-product-stock.md),
  [ADR-016](../adr/016-cache-aside-generalized.md)

Two latent key-shape gaps in the generalized `CACHE_KEYS` registry:

**CACHE-003 — no schema-version segment.** Cache reads in
`apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
L43 use a TypeScript generic assertion only (`cache.get<ProductStockGetResponseDto>(cacheKey)`).
A breaking change to the DTO shape would deserialize in-flight cached
entries against the new shape for one TTL window — silently mismatched
fields, no runtime validation. The original audit's mitigation: include
a schema-version segment in the key (`ris:inventory:stock:v2:<productId>:...`)
and bump it on breaking shape changes so old entries become unreachable
immediately on deploy.

**CACHE-009 — no tenant segment.** `libs/cache/cache-keys.ts` L28–L37 builds
keys as `ris:inventory:stock:<productId>:<facet>`. There is no
tenant/store segment. The project has no multi-tenant model today, so
this is latent — but once introduced, two tenants holding the same
`productId` would read each other's cached stock. This is a correctness
and data-leak risk, not just a collision. The original audit's mitigation:
prepend the tenant identifier (`ris:t:<tenantId>:inventory:stock:<productId>:...`).

Why they matter together: both are key-shape changes that ripple through
every reader, writer, and invalidator. Bundling them keeps the
invalidation transition window short (one rolling deploy for both
segments rather than two).

## Goal

`CACHE_KEYS.inventoryStock*` builders accept an optional schema-version
segment (defaulted on the call site to a constant per aggregate) and
reserve a position for a tenant segment that activates when a
`tenantId` argument is supplied. The legacy key shape is still wiped on
invalidate so in-flight entries do not survive a deploy. The retail
`CACHE_KEYS.retailOrder*` builders gain the same shape for parity.

## Acceptance criteria

- [ ] `CACHE_KEYS.inventoryStock(productId, storageIds)` produces
      `ris:inventory:stock:v1:<productId>:<facet>` by default
      (version constant lives next to the builder so a future bump is
      a one-line change). Tests in `libs/cache/spec/cache-keys.spec.ts`
      lock in the new shape.
- [ ] `CACHE_KEYS.inventoryStock(productId, storageIds, { tenantId })`
      produces `ris:t:<tenantId>:inventory:stock:v1:<productId>:<facet>`
      when `tenantId` is supplied. Without `tenantId` the prefix omits
      the `t:` segment entirely (i.e. no `ris:t:default:...` — a missing
      tenantId means single-tenant mode).
- [ ] `CACHE_KEYS.inventoryStockPrefix(productId)` and
      `CACHE_KEYS.inventoryStockPrefix(productId, { tenantId })` produce
      the matching prefixes used by `delByPrefix`. Verified by tests.
- [ ] `StockCache.invalidate` (`apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`)
      wipes both the *new* `ris:...:v1:...` prefix and the legacy
      pre-fix-task `ris:inventory:stock:<id>:` prefix on every invalidate
      call, so a rolling deploy does not leave stale-shape entries that
      survive past TTL.
- [ ] Same shape applied to `CACHE_KEYS.retailOrder*`. The retail
      module does not actively cache today (verify by grep) but the
      builder contract must be consistent.
- [ ] All existing specs pass (or are updated with one-line explanatory
      comments on each change). `cache-keys.spec.ts` covers both the
      single-tenant default path and the tenant-supplied path.

## Files likely involved

- `libs/cache/cache-keys.ts` — extend the builders. The cleanest
  approach is `inventoryStock(productId, storageIds?, opts?: { tenantId?: string })`
  and a shared private helper that assembles the prefix. The schema
  version is a module-private const (`const INVENTORY_STOCK_KEY_VERSION = 'v1'`)
  so bumping it is one edit.
- `libs/cache/spec/cache-keys.spec.ts` — add cases for tenant-supplied
  and default paths, schema-version segment position, and
  prefix/full-key consistency.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
  — invalidate path wipes both the new and the legacy `ris:inventory:stock:<id>:`
  prefixes. Reads use the new builder unconditionally. Writes use the
  new builder unconditionally.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`
  — update key-string assertions to the new shape.
- `test/system-api.e2e-spec.ts` — `getCachedStock` / `setCachedStock`
  helpers (L38–L44) call `CACHE_KEYS.inventoryStock`; update the
  assertions if the e2e key expectations changed (they should not —
  the helpers go through the builder).
- `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
  — `IStockCacheGetPayload` / `IStockCacheSetPayload` / `IStockCacheInvalidatePayload`
  may need to grow an optional `tenantId` field if you propagate it
  from the use case. If the project has no tenant model yet, this can
  be deferred — but the *builder signature* must accept it now.

## Steps

1. Read `libs/cache/cache-keys.ts` and `libs/cache/spec/cache-keys.spec.ts`
   end-to-end. The legacy `productStock*` builders (L46–L55) are kept
   for the existing one-deploy transition window from ADR-016 and **must
   remain unchanged** — they are part of the audit-tracked legacy
   surface. This task adds a *new* transition window for the v1-vs-pre-v1
   inventory key shape; the legacy `stock:<id>:*` surface is separate.
2. Pick the segment order. Two reasonable conventions:
   - `ris:t:<tenantId>:<service>:<aggregate>:<version>:<id>:<facet>` — tenant
     closest to root, schema version near the aggregate. Recommended:
     SCAN by tenant prefix becomes easy ("wipe everything for tenant X")
     and the version segment groups with the aggregate it scopes.
   - `ris:<service>:<aggregate>:<version>:t:<tenantId>:<id>:<facet>` — version
     closest to the aggregate, tenant near the id. Plausible but harder
     to SCAN-by-tenant.
   Document the chosen order in the ADR; the recommended is the first.
3. Implement the schema-version segment as a *required* part of the new
   key shape with a per-aggregate constant (`v1`). The constant lives
   next to the builder. The builder does not take a `version` argument
   — that would push the bump complexity to every call site.
4. Implement the tenant segment as an *optional* part. Missing tenant
   means single-tenant mode; the segment is omitted entirely (not
   defaulted to `default` — a future migration to multi-tenant would
   then re-key all entries via a deploy, not silently inherit a
   "default" tenant).
5. Wire `StockCache.invalidate` to call `delByPrefix` on:
   - the new shape's prefix per `productId`,
   - the pre-task `ris:inventory:stock:<productId>:` prefix per
     `productId` (the in-flight entries from before this fix-task
     deployed),
   - the ADR-016 legacy `stock:<productId>:` prefix per `productId`
     (already wiped today; keep it).
   That is three `delByPrefix` calls per productId. Document the rolling-
   deploy transition window in the ADR.
6. Update `cache-keys.spec.ts` to assert the new shape verbatim, both
   single-tenant and tenant-supplied paths. Update `stock.cache.spec.ts`
   for the invalidate call count change (3 prefixes per productId
   instead of 2).
7. Apply the same tenant + version shape to `CACHE_KEYS.retailOrder*`
   even though no consumer caches today — the builder contract has to
   be consistent so future retail-cache work doesn't re-litigate the
   shape.
8. Run the verification gate.

## Documentation updates required

- [ ] **ADR required.** Create `docs/adr/<NNNN>-<slug>.md` (next free
      number in `docs/adr/index.md`). Document:
      - the segment order chosen and why (with the rejected alternative);
      - the version-bump procedure (constant edit + one deploy);
      - the tenant segment is *opt-in by argument*, not defaulted;
      - the transition-window strategy for invalidating pre-v1 entries.
- [ ] Update `docs/adr/index.md` with the new entry.
- [ ] Update `CLAUDE.md` "Cache-key convention" section to reflect the
      new shape `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`.
      The current text reads `ris:<service>:<aggregate>:<id>[:<facet>]`
      (ADR-016 shape) and must change.
- [ ] No `README.md` update required — keys are internal; record this
      explicitly in the carryover with the reason.

## Verification

- [ ] `yarn install` succeeds
- [ ] `yarn build` succeeds
- [ ] `yarn lint` succeeds (max-warnings 0)
- [ ] `yarn test:unit` succeeds (all updated specs pass)
- [ ] `grep -rn 'stock:[0-9]\+:' apps/*/src libs/*/src` returns matches
      *only* under `libs/cache/cache-keys.ts` (the legacy builders) —
      every other usage routes through `CACHE_KEYS.inventoryStock*`.
- [ ] E2E run (`yarn test:e2e`) — optional but recommended: the
      `system-api.e2e-spec.ts` cache assertions exercise the new
      builder end-to-end. If you skip e2e, record in carryover.

## Carryover

Write `_fix-cache-keys-tenant-and-schema-version-summary.md` with:

- Files edited (paths + one-line summary)
- Tests added (paths + what each asserts)
- ADR created (path + summary)
- Documentation updates
- Verification results
- Anything unexpected — surface for human review
