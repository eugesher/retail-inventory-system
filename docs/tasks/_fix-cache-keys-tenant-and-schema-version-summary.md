# Fix-task summary — cache-key schema-version and tenant segments

Closes **CACHE-003** (no schema-version segment) and **CACHE-009** (no
tenant segment) from
[`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md).

## Files edited

- `libs/cache/cache-keys.ts` — `inventoryStock*` and `retailOrder*`
  builders now emit `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`.
  Added per-aggregate version constants (`INVENTORY_STOCK_KEY_VERSION`,
  `RETAIL_ORDER_KEY_VERSION = 'v1'`). Added
  `inventoryStockLegacyPrefix` (invalidate-only) for the pre-v1
  transition window. Pre-ADR-016 `productStock*` builders unchanged.
- `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
  — `IStockCacheGetPayload`, `IStockCacheSetPayload`, and
  `IStockCacheInvalidatePayload` gain an optional `tenantId` field. No
  use case populates it today (no tenant model in the domain yet); the
  port surface is ready for a future migration.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
  — `get` / `set` / `getOrLoad` thread `tenantId` into the key builder.
  `invalidate` fans out three `delByPrefix` calls per productId
  (current v1 prefix, pre-v1 `inventoryStockLegacyPrefix`, pre-ADR-016
  `productStockPrefix`). Audit-tracking header comment updated:
  CACHE-003 / CACHE-009 now closed by ADR-022.
- `CLAUDE.md` — "Cache-key convention" paragraph updated to the new
  shape, with a callout for the version constants and the opt-in
  tenant argument; the cache audit-status bullet updated to reflect
  CACHE-003 / CACHE-009 closure.
- `docs/adr/index.md` — added ADR-022 row.

## Tests added / updated

- `libs/cache/spec/cache-keys.spec.ts` — added `inventoryStock`
  single-tenant + tenant-supplied path coverage; `inventoryStockPrefix`
  / `inventoryStock` consistency (prefix is a strict prefix of every
  full-key shape); `inventoryStockLegacyPrefix` returns the pre-v1
  shape; the `retailOrder*` v1 + tenant-supplied shape. Pre-ADR-016
  `productStock*` assertions preserved verbatim.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`
  — all `ris:inventory:stock:42:*` literals retargeted to
  `ris:inventory:stock:v1:42:*`. New tests:
  - `get` builds a tenanted key when `tenantId` is supplied
    (`ris:t:store-7:inventory:stock:v1:42:__all__`).
  - `invalidate` now expects **3** `delByPrefix` calls per unique
    productId (v1 + pre-v1 + pre-ADR-016) instead of 2.
  - `invalidate` with a `tenantId` scopes only the v1 wipe; the pre-v1
    and pre-ADR-016 wipes remain tenant-agnostic by construction (the
    older shapes never carried a tenant segment).
  - The "debug-logs total unlinked count" mock tightened to match only
    `ris:inventory:stock:v1:` so the pre-v1 transition wipe does not
    double-count in the assertion.

## ADR created

- [`docs/adr/022-cache-keys-tenant-and-schema-version.md`](../adr/022-cache-keys-tenant-and-schema-version.md)
  — chosen segment order
  (`ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`)
  with the rejected alternative documented; per-aggregate version
  constant + bump procedure; tenant-is-opt-in-not-defaulted reasoning;
  three-prefix transition-window strategy; consequences and follow-ups
  (remove pre-v1 fan-out once dashboards confirm zero hits; add
  runtime DTO validation on read; thread `tenantId` from the gateway
  once a tenant model exists).

## Documentation updates

- ADR-022 written and indexed.
- `CLAUDE.md` "Cache-key convention" + cache audit-status bullet
  updated.
- `README.md` not updated — cache-key shapes are internal
  implementation detail (operators inspect via Redis CLI; no external
  consumer reads the shape). Recorded explicitly here per
  `CONVENTIONS.md` §5.

## Verification

| Check                | Result |
| -------------------- | ------ |
| `yarn install`       | OK     |
| `yarn build`         | OK — all four apps compile (webpack `compiled successfully`) |
| `yarn lint`          | OK — exit 0, max-warnings 0 honoured |
| `yarn test:unit`     | OK — 168 / 168 tests pass across 29 suites |
| `yarn test:e2e`      | Not run — local infra (MySQL/RabbitMQ/Redis) not running; would require `yarn test:infra:reload` (~slow). The e2e helpers in `test/system-api.e2e-spec.ts` go through `CACHE_KEYS.inventoryStock`, so they pick up the v1 segment transparently without source changes. Recommend running before merge. |

### Legacy-literal grep

The task's verification step asks for
`grep -rn 'stock:[0-9]\+:' apps/*/src libs/*/src` to match **only**
under `libs/cache/cache-keys.ts`. Current matches outside that file:

- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`
  — six lines, all inside the `invalidate` describe block, asserting
  the literal pre-v1 and pre-ADR-016 prefixes that the invalidate
  contract emits.
- `libs/cache/spec/redis-cache.adapter.spec.ts` — adapter-layer test
  inputs (unchanged by this task; predate it).

These spec-file matches are the regression boundary for the
invalidate contract; the in-file conventions header on
`stock.cache.spec.ts` already names cache-key strings as part of the
production contract that the spec locks in. **No production code in
`apps/*/src` writes a legacy literal** — every emission routes
through `CACHE_KEYS.inventoryStockLegacyPrefix` or
`CACHE_KEYS.productStockPrefix`. The spirit of the verification check
is met.

## Things worth a human glance

1. **Three-prefix invalidate adds one no-op SCAN per productId per
   confirm RPC** until the pre-v1 cleanup task runs. The cost is
   small (KeyvRedis SCAN on an empty match set), but worth a follow-up
   to add hits-per-prefix instrumentation so we know when it is safe
   to drop the pre-v1 fan-out.
2. **`tenantId` plumbing is currently dead code at the use-case
   layer.** Nothing populates it; the field exists on the port today
   so a future tenant-aware migration is a wiring change, not a port
   contract change. If the team prefers to defer port surface changes
   until a domain need lands, the optional field could be reverted
   from the port and added later (the builder signature is the
   load-bearing surface — the port field is a convenience).
3. **The verification grep wording in the task file conflicts slightly
   with its own "update the invalidate spec" step.** The spec file
   *must* contain literal pre-v1 and pre-ADR-016 strings to assert the
   invalidate contract — flagged so future fix-tasks can re-phrase the
   grep check (e.g. limit it to non-spec sources via a `--include`).
4. **`retailOrder*` builders changed shape but have no production
   consumers.** Verified via grep before editing. The change keeps the
   builder contract consistent across aggregates; first retail-cache
   consumer can use it without re-litigation.
