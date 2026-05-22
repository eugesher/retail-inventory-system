---
date: 2026-05-20
status: active
supersedes: docs/audits/audit-2026-05-08.md
context: post-architecture-migration re-audit
---

# Audit Report — 2026-05-20 (follow-up to 2026-05-08)

## Summary

The 2026-05-08 audit ran against the pre-migration codebase, when stock-cache logic lived in `apps/inventory-microservice/src/app/common/modules/product-stock-common/` and the key registry sat in `libs/common/cache/cache.helper.ts`. The architecture migration (ADR-004 hexagonal per service, ADR-005 split of `libs/common`, ADR-006 the cache port, ADR-016 the generalized key convention + `delByPrefix` primitive) moved the same logic into `libs/cache/` (port + Redis adapter + `CACHE_KEYS` registry + `@Cacheable` decorator skeleton) and into a domain-shaped `IStockCachePort` adapter at `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`. None of that restructure changed the ADR-002 cache-aside *contract* — by design, per ADR-006 §"Relationship to ADR-002" — so most of the original audit's architectural concerns survived the move intact and are merely annotated at new line numbers.

Verdict distribution across the 17 original issues: **9 still-relevant** (the architectural CACHE-001/002/003/004/005, the latent multi-tenant CACHE-009, and the cross-cutting TEST-001/002/003), **6 resolved-by-migration** (CACHE-006 and the three key-shape bugs CACHE-010/011/012 closed by ADR-016, plus the missing domain-spec items CACHE-007/008 closed by the new per-module spec sibling layout), and **2 informational-no-action** (CODE-001 is now self-documented inline at the filter site; DOCS-001 is partially addressed by the canonical-reference header in `stock.cache.spec.ts`). No issue is `no-longer-applicable` and no issue requires `needs-investigation` — every original finding is reachable in the new code or in the new test layout, so each verdict is defensible from the cited file alone.

Breakdown by classification (with new verdict column):

| Classification | Count | Codes                                                                | Still-relevant | Resolved | Info-no-action |
| -------------- | ----: | -------------------------------------------------------------------- | -------------: | -------: | -------------: |
| architecture   |     5 | CACHE-001, CACHE-002, CACHE-003, CACHE-004, CACHE-005                |              5 |        0 |              0 |
| bug            |     4 | CACHE-009, CACHE-010, CACHE-011, CACHE-012                           |              1 |        3 |              0 |
| missing-impl   |     2 | CACHE-007, CACHE-008                                                 |              0 |        2 |              0 |
| other          |     4 | TEST-001, TEST-002, TEST-003, CODE-001                               |              3 |        0 |              1 |
| config         |     1 | CACHE-006                                                            |              0 |        1 |              0 |
| docs           |     1 | DOCS-001                                                             |              0 |        0 |              1 |
| **total**      |    17 |                                                                      |          **9** |    **6** |          **2** |

## Issue verdicts

### CACHE-001 — Cache-aside read/write race window

- **Code**: `CACHE-001`
- **Original classification**: architecture
- **New verdict**: `still-relevant`
- **Path remap**: `apps/inventory-microservice/src/app/common/modules/product-stock-common/product-stock-common.service.ts` (~L73) → `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts` (L64–L74).
- **Reasoning**: The miss-then-set sequence in `GetStockUseCase.execute` still calls `repository.aggregateForProduct` and then `stockCache.set` with no single-flight or version-stamp protection. The block carries an explicit `AUDIT-2026-05-08 [CACHE-001]` annotation at L67 marking the same race the original audit identified. The migration preserved ADR-002's contract verbatim (per ADR-006), so the window did not narrow. ADR-016 §3 explicitly confirms this race remains open after task-11.
- **Resolution**: Closed by [ADR-021](../adr/021-cache-single-flight-and-ttl-jitter.md). `IStockCachePort.getOrLoad` wraps the miss path in an in-process single-flight against `ICachePort.singleFlight`, so concurrent miss-cohorts share one loader invocation. The leader is the only one that runs the loader and writes back; followers reuse the leader's result. The write-back applies ±10% TTL jitter (see CACHE-004 resolution below).

### CACHE-002 — Post-commit-only invalidate contract is comment-enforced

- **Code**: `CACHE-002`
- **Original classification**: architecture
- **New verdict**: `still-relevant`
- **Path remap**: `apps/inventory-microservice/src/app/common/modules/product-stock-common/product-stock-common.service.ts` (~L102) → contract is now enforced by comment at `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts` (L122–L132) and the public method lives on `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts` (L35).
- **Reasoning**: `IStockCachePort.invalidate(payload)` is publicly exposed and the "must run after the transaction commits" rule is documented only in a comment block above the call site (the `reserve-stock-for-order` use case). The comment is now *more* prominent than before — ADR-016 awaits the call rather than fire-and-forgetting it — but nothing in the type system prevents a future use case from invoking `stockCache.invalidate(...)` inside an `entityManager.transaction(...)` callback. The structural risk the original audit flagged is unchanged.
- **Resolution**: Closed by [ADR-023](../adr/023-cache-invalidate-post-commit-by-type.md). `IStockCachePort.invalidate(...)` is removed from the public port surface; callers route writes through `withInvalidation(work, resolveItems, opts)`, which awaits `work` and only then fans out the prefix-delete via a private `invalidatePrefixes` helper. The post-commit ordering is type-enforced — a caller cannot reach the underlying invalidate from inside a transaction callback because the type signature forbids it.

### CACHE-003 — Untyped cache values; no schema-version segment in keys

- **Code**: `CACHE-003`
- **Original classification**: architecture
- **New verdict**: `still-relevant`
- **Path remap**: `libs/common/cache/cache.helper.ts` (~L1) → `libs/cache/cache-keys.ts` (L26–L40, `CACHE_KEYS.inventoryStock*`) and the read site `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts` (L43, `cache.get<ProductStockGetResponseDto>(...)`).
- **Reasoning**: The new builder `CACHE_KEYS.inventoryStock(productId, storageIds)` produces `ris:inventory:stock:<productId>:<facet>` with no schema-version segment. `StockCache.get` still uses a generic type assertion (`cache.get<ProductStockGetResponseDto>`) with no runtime validation on read. A DTO-shape change would still leave one TTL window of entries that deserialize correctly into a mismatched shape. The `cache-keys.ts` header comment (L23–L24) explicitly tracks this as open.
- **Resolution**: Closed by [ADR-022](../adr/022-cache-keys-tenant-and-schema-version.md). `CACHE_KEYS.inventoryStock*` and `CACHE_KEYS.retailOrder*` builders now emit `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]` with per-aggregate version constants (`INVENTORY_STOCK_KEY_VERSION`, `RETAIL_ORDER_KEY_VERSION` — currently `v1`). A breaking DTO shape change bumps the constant in one line and pre-bump entries become unreachable on the next deploy.

### CACHE-004 — TTL has no jitter (thundering-herd risk)

- **Code**: `CACHE-004`
- **Original classification**: architecture
- **New verdict**: `still-relevant`
- **Path remap**: `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts` (~L28) → `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts` (L61–L75, `set` method).
- **Reasoning**: `StockCache.set` passes `configService.get<number>('CACHE_TTL_MS_PRODUCT_STOCK')` straight into `cache.set(key, data, ttl)`. There is no `±10%` jitter applied here or in the underlying `RedisCacheAdapter.set` (`libs/cache/redis-cache.adapter.ts` L48–L61). Any batch of writes that lands within one event-loop tick will expire on the same wall-clock band. The original mitigation still applies verbatim.
- **Resolution**: Closed by [ADR-021](../adr/021-cache-single-flight-and-ttl-jitter.md) (bundled with CACHE-001 per the original audit's coupling note). `StockCache.set` (and the `getOrLoad` write-back) apply ±10% uniform jitter (`Math.floor(ttl + (Math.random() * 2 - 1) * 0.1 * ttl)`) before delegating to `cache.set`. The floor on the lower bound preserves ADR-002's TTL-as-safety-net role.

### CACHE-005 — Redis-down produces duplicate warn logs (get + set)

- **Code**: `CACHE-005`
- **Original classification**: architecture
- **New verdict**: `still-relevant`
- **Path remap**: `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts` (~L32) → `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts` (`get` at L36–L59, `set` at L61–L75) and the use case at `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts` (L54–L74).
- **Reasoning**: `StockCache.get` warn-logs and returns `undefined` when `cache.get` throws. `GetStockUseCase` interprets `undefined` as a miss, runs the DB aggregation, and unconditionally calls `stockCache.set`. During a Redis outage `set` will also reject and produce a second warn-log. No `cacheAvailable` flag is propagated. The path is functionally correct (correctness fallback still works) but emits two warn lines per request — the same duplicate-log signature the original audit identified.
- **Resolution**: Closed by changing `IStockCachePort.get`'s return shape to `{ value: ProductStockGetResponseDto | undefined; available: boolean }`. When the underlying `cache.get` rejects, `available: false` short-circuits the single-flight + write-back path inside `getOrLoad`, so a Redis-down request emits exactly one warn line ("Failed to read from cache") instead of three.

### CACHE-006 — Layer reach-through fragility; pin `cacheable` major

- **Code**: `CACHE-006`
- **Original classification**: config
- **New verdict**: `resolved-by-migration`
- **Path remap**: `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts` (~L37) → `libs/cache/redis-cache.adapter.ts` (L95–L165, the SCAN+UNLINK path) and `package.json` L66 (`"cacheable": "^2.3.4"`).
- **Reasoning**: The reach-through is now confined to one lib file. `RedisCacheAdapter.delByPrefix` opens an OTel span and walks `cache.stores[0].store` to obtain the `KeyvRedis` adapter (`getRedisAdapter` at L154–L165); no app touches `@nestjs/cache-manager` or `@keyv/redis` directly. `grep -rE 'redis|cache-manager|keyv' apps/*/src` returns zero matches, which ADR-016 §"Consequences" calls out as a verification gate. The `cacheable` package is pinned to the v2 major via the caret in `package.json` L66 (`^2.3.4` allows ≥2.3.4 <3.0.0). The annotation comment in `stock.cache.ts` L25 still lists CACHE-006 as open, but reading ADR-016 §4 ("CACHE-006 (layer reach-through): the only place that reaches through to `KeyvRedis` is `libs/cache/redis-cache.adapter.ts`") confirms it as closed — the in-code comment is a stale tracking note, not evidence the issue persists.

### CACHE-007 — Missing domain unit coverage for skip-cache and read-error paths

- **Code**: `CACHE-007`
- **Original classification**: missing-impl
- **New verdict**: `resolved-by-migration`
- **Path remap**: no production location → new specs under `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/get-stock.use-case.spec.ts` and `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`.
- **Reasoning**: The skip-cache `entityManager` branch is now covered by `get-stock.use-case.spec.ts` L98–L114, the `ignoreCache` branch by L116–L127, and the "prefers entityManager when both" branch by L129–L142. The `cache.get` throws → DB-fallback path is covered at the adapter level by `stock.cache.spec.ts` L108–L120 (which asserts `StockCache.get` returns `undefined` and warn-logs when the underlying `cache.get` rejects). Since `GetStockUseCase` always observes `IStockCachePort.get`'s `undefined-or-DTO` contract, the use case's miss-then-DB test (`get-stock.use-case.spec.ts` L64–L82) is the correct level of coverage for the fault-injection scenario. All three coverage gaps from the original audit are filled.

### CACHE-008 — Missing domain unit coverage for transaction-failure path on order confirm

- **Code**: `CACHE-008`
- **Original classification**: missing-impl
- **New verdict**: `resolved-by-migration`
- **Path remap**: no production location → new spec `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/reserve-stock-for-order.use-case.spec.ts` (L234–L250).
- **Reasoning**: The spec test "error-logs and rethrows when the transaction rejects, and does not invalidate" uses a fault-injectable mock (`transaction.mockRejectedValue(err)`) and explicitly asserts `expect(stockCache.invalidate).not.toHaveBeenCalled()` and `expect(publisher.publishStockLow).not.toHaveBeenCalled()`. This is precisely the "no cache mutation / no invalidate call" expectation the original audit specified.

### CACHE-009 — Cache keys lack a tenant segment

- **Code**: `CACHE-009`
- **Original classification**: bug
- **New verdict**: `still-relevant`
- **Path remap**: `libs/common/cache/cache.helper.ts` (~L17, `keyPrefixes.productStock`) → `libs/cache/cache-keys.ts` (L26–L40, `CACHE_KEYS.inventoryStock*`).
- **Reasoning**: The new builders read `ris:inventory:stock:<productId>:<facet>` with no tenant segment. The cache-keys.ts header comment L23–L24 explicitly tracks CACHE-009 as open. No tenant model exists today so the bug is still latent, but the structural absence is unchanged. ADR-016 §"Still open" lists CACHE-009 by name.
- **Resolution**: Closed by [ADR-022](../adr/022-cache-keys-tenant-and-schema-version.md) (bundled with CACHE-003 — same builder change). The cache-key builders accept an optional `opts?: { tenantId?: string }` and prepend `t:<tenantId>:` to the key when supplied. The segment is omitted entirely when `tenantId` is missing (no silent `t:default:…`), so single-tenant mode remains the wire-format unchanged. No use case populates `tenantId` today — the port surface is ready for a future migration.

### CACHE-010 — `storageIds` sort comparator uses `charCodeAt(0)` only

- **Code**: `CACHE-010`
- **Original classification**: bug
- **New verdict**: `resolved-by-migration`
- **Path remap**: `libs/common/cache/cache.helper.ts` (~L37) → `libs/cache/cache-keys.ts` (L30–L37).
- **Reasoning**: `CACHE_KEYS.inventoryStock` sorts via `a.localeCompare(b)` (L34). The spec `libs/cache/spec/cache-keys.spec.ts` L25–L31 locks the fix in: both `['ab','aa']` and `['aa','ab']` produce the same `ris:inventory:stock:1:aa,ab` key. The legacy `CACHE_KEYS.productStock` builder retains the broken `charCodeAt(0)` comparator on purpose (L52) for the one-deploy transition window, but new code never writes through it.

### CACHE-011 — Literal `*` "all-storages" sentinel could be confused with a glob

- **Code**: `CACHE-011`
- **Original classification**: bug
- **New verdict**: `resolved-by-migration`
- **Path remap**: `libs/common/cache/cache.helper.ts` (~L38) → `libs/cache/cache-keys.ts` (L34).
- **Reasoning**: The new sentinel is `'__all__'`, a non-meta string. Spec `cache-keys.spec.ts` L14–L19 asserts `expect(CACHE_KEYS.inventoryStock(42)).not.toMatch(/\*/)`. A future invalidator that issues `cache.del('ris:inventory:stock:<id>:__all__')` will hit the exact key.

### CACHE-012 — `invalidateNamedKeys` fallback covers only single-storage keys

- **Code**: `CACHE-012`
- **Original classification**: bug
- **New verdict**: `resolved-by-migration`
- **Path remap**: `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts` (~L209, `invalidateNamedKeys`) → method does not exist post-migration; replaced by `ICachePort.delByPrefix` (`libs/cache/cache.port.ts` L18) and `RedisCacheAdapter.delByPrefix` (`libs/cache/redis-cache.adapter.ts` L95–L152).
- **Reasoning**: The named-key DEL fallback is gone. `delByPrefix` on a non-Redis backend returns 0 and the call is a documented no-op (entries expire on TTL). The combo-key gap the original audit identified no longer has a code path to manifest in. ADR-016 §"Still open" lists CACHE-012 only to note the fallback is now a documented no-op rather than incomplete.

### TEST-001 — Snapshot-only assertions mask regression source

- **Code**: `TEST-001`
- **Original classification**: other
- **New verdict**: `still-relevant`
- **Path remap**: `test/system-api.e2e-spec.ts` (no path change).
- **Reasoning**: The e2e file still uses `toMatchSnapshot()` as the sole assertion on response bodies and DB rows in many places (e.g. error-path assertions at L218, L226, L289, L309 and the whole `assertData` helper at L244–L250). The migration added explicit `toMatchObject` cache-state assertions (e.g. L141, L153, L455) but didn't pair those with explicit field assertions on the snapshot calls. The original concern — snapshot diffs collapse cache/DB/DTO regressions into one signal — survives.
- **Resolution**: Closed. Every `toMatchSnapshot()` call on an error-path body in `test/system-api.e2e-spec.ts` is now paired with explicit assertions on `statusCode`, `error`, and key message substrings. The `assertData` helpers used by the order-create and order-confirm tests get per-row-category assertions on header status (e.g. `OrderStatusEnum.CONFIRMED`), line counts, and the `quantity === -1` sign on `productStockRows`. Snapshots remain as the comprehensive baseline — explicit assertions are additive tripwires that label the regression source.

### TEST-002 — Pino logger disabled in E2E (loses cache-hit side-channel)

- **Code**: `TEST-002`
- **Original classification**: other
- **New verdict**: `still-relevant`
- **Path remap**: `test/system-api.e2e-spec.ts` (no path change).
- **Reasoning**: All three bootstrap calls in the e2e spec still pass `logger: false` — retail microservice at L52, inventory microservice at L67, and the API gateway at L77. The `cacheHit` log field that `StockCache.get` and `set` emit is therefore invisible to e2e assertions; tests rely on direct cache reads through `getCachedStock` instead. The mitigation the original audit suggested (a Pino stream piped into a memory transport) is not in place.
- **Resolution**: Closed. The three `logger: false` flags are gone from `test/system-api.e2e-spec.ts`. A memory-backed `Writable` is installed by `test/jest.setup.ts` (via `installMemoryPinoLogger()` from `libs/observability/testing/pino-memory-stream.ts`) *before* any spec import runs — the only point at which `LoggerModuleConfig`'s constructor can see the destination, because each `@Module({ imports: [...] })` decorator evaluates `LoggerModule.forRoot(new LoggerModuleConfig(...))` eagerly at AppModule load time. The destination is plumbed via the nestjs-pino tuple form `pinoHttp: [Options, DestinationStream]`. One log-based side-channel assertion (`cacheHit: true` on the primed-cache GET test) demonstrates the capability end-to-end.

### TEST-003 — `makePinoLoggerMock()` factory would dedupe spec setup

- **Code**: `TEST-003`
- **Original classification**: other
- **New verdict**: `still-relevant`
- **Path remap**: cross-cutting; the duplicated factory now appears in every spec that mocks `PinoLogger`. Examples: `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/get-stock.use-case.spec.ts` L9–L18, `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/reserve-stock-for-order.use-case.spec.ts` L17–L26, `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts` L27–L36, `apps/retail-microservice/src/modules/orders/application/use-cases/spec/confirm-order.use-case.spec.ts` L17–L26 (and the sibling `create-order` / `get-order` specs follow the same pattern).
- **Reasoning**: Each spec redefines the same `LoggerMock` type alias and `makeLogger()` factory inline. The duplication count grew rather than shrank during the migration because every per-module spec was written from the template. No shared helper has been hoisted into a `libs/observability/testing` or `test/utils` location.
- **Resolution**: Closed. `makePinoLoggerMock()` and the `PinoLoggerMock` type alias live at `libs/observability/testing/pino-logger.mock.ts`, exposed via the deep-import path `@retail-inventory-system/observability/testing` (mirroring the existing `/tracer` deep-import convention). The `testing/` barrel is intentionally **not** re-exported from `libs/observability/index.ts`, keeping production import graphs out. Eight specs (the seven originally listed plus `stock-typeorm.repository.spec.ts`, which the audit verification grep caught) replace their inline factory with the helper. The notification microservice's class-based `FakeLogger` is left untouched per the original DOCS-001 caveat — the two styles are deliberately different and serve different testing shapes.

### CODE-001 — Defensive filter `!!item.storageId` is unreachable today

- **Code**: `CODE-001`
- **Original classification**: other
- **New verdict**: `informational-no-action`
- **Path remap**: `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-order-confirm.service.ts` (~L117) → `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts` (L134–L156).
- **Reasoning**: The filter survived the migration with a thirteen-line comment block above it that documents the forward-looking-NULL-storage rationale and the type-narrowing constraint verbatim — exactly what the original audit's informational note asked for. The annotation `AUDIT-2026-05-08 [CODE-001]` is preserved at L149. No further documentation step is justified; the rationale lives where future readers will encounter it.

### DOCS-001 — Convention inconsistency between microservice spec layouts

- **Code**: `DOCS-001`
- **Original classification**: docs
- **New verdict**: `informational-no-action`
- **Path remap**: cross-cutting; relevant sites are `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts` L1–L9 (declares itself the canonical reference), `apps/retail-microservice/src/modules/orders/.../spec/*` (follows the same pattern), and `apps/notification-microservice/src/modules/notifications/.../spec/*` (uses a deliberately different `FakeLogger`-class pattern with hand-rolled `InMemoryNotifier` test doubles).
- **Reasoning**: The original audit recorded this as informational with no concrete action. The migration unified the inventory + retail patterns onto `jest.Mocked<Pick<T, ...>>` + plain-object `LoggerMock` + `jest.resetAllMocks()` and the inventory cache spec's header comment now serves as the canonical reference. The notification microservice intentionally diverges — it uses class-based test doubles because they fit its no-DB / no-RPC shape better. The divergence is meaningful design, not drift. Treating it as a docs item would force a single convention over two genuinely different testing styles; no action is justified.

## Verification of issues annotated as resolved by the migration

Re-verified four of the six `resolved-by-migration` verdicts where the original audit (the `Status:` line) claimed the migration had already closed the issue. The verdict above stands in each case; the verification notes here cite the post-migration code that demonstrates the fix.

- **CACHE-006**. Verified at `libs/cache/redis-cache.adapter.ts` L154–L165 (`getRedisAdapter` is the only reach-through to `KeyvRedis`), `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts` (depends only on `ICachePort` / `CACHE_PORT`), and `package.json` L66 (`"cacheable": "^2.3.4"` pins the major). The annotation comment in `stock.cache.ts` L25 listing CACHE-006 as "open" is stale and should be removed in a future cleanup pass; it does not invalidate the resolution.
- **CACHE-010**. Verified at `libs/cache/cache-keys.ts` L34 (`a.localeCompare(b)`) and `libs/cache/spec/cache-keys.spec.ts` L25–L31 (locks both permutations to the same key).
- **CACHE-011**. Verified at `libs/cache/cache-keys.ts` L34 (`'__all__'` literal) and `libs/cache/spec/cache-keys.spec.ts` L14–L19 (`expect(...).not.toMatch(/\*/)`).
- **CACHE-012**. Verified at `libs/cache/cache.port.ts` L18 (`delByPrefix` is the only multi-key primitive) and `libs/cache/redis-cache.adapter.ts` L100–L105 (non-Redis backend returns 0 — documented no-op). The `invalidateNamedKeys` method has no successor.

## Annotation Warnings

Carrying forward from the original audit. Cross-cutting items with no single annotation target:

| Code        | Reason                                                                                                                                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEST-001`  | Cross-cutting test refinement across `test/system-api.e2e-spec.ts`; no single line to annotate. Resolved across multiple `describe` blocks in the same file (see Resolution under TEST-001).                                                                                                                                         |
| `TEST-002`  | E2E test-infra item (`logger: false` on three bootstrap calls in `test/system-api.e2e-spec.ts`); the annotation target was the test-infra change itself, now realised by `test/jest.setup.ts` + `libs/observability/testing/pino-memory-stream.ts`.                                                                                  |
| `TEST-003`  | Cross-cutting spec refactor across eight spec files; the canonical helper now lives at `libs/observability/testing/pino-logger.mock.ts` (see Resolution under TEST-003).                                                                                                                                                             |
| `DOCS-001`  | Informational note about cross-microservice spec-layout convention; deliberately left in-spec rather than promoted (see verdict).                                                                                                                                                                                                    |
