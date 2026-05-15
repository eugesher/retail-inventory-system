# _carryover-06.md — Write caching stack (Phase: caching/)

> Generated 2026-05-16 by the task-06 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-05.md` (which
> built on `_carryover-04.md` → `_carryover-03.md` → `_carryover-02.md`
> → `_carryover-01.md`, the source of the SHA pin
> `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-05.md` was read in full. The four messaging articles
it produced are all on `status: review` and provide back-link
targets for this group's `cache-aside-pattern.md` (it
forward-links to `[[message-vs-event-patterns]]` for the
"awaited invalidate vs fire-and-forget event" contrast on the
post-commit side-effects). The HEAD SHA recorded in
`_carryover-01.md` (`84b1507c68fd9ee02b185eef3c4594b6fe02f664`)
is used for every GitHub permalink in every caching article.

No build smoke-check was run inside the session — only
docs-only files were touched under
`docs/architecture-migration-ru/caching/`. The working tree
was clean at session start; branch is `migration-guide`. No
code under `apps/` or `libs/` was modified during this
docs-only session. No `git` mutating commands were executed.

Discrepancies check (task-01 §4): every clarification-group
library is present in `package.json`:

- `@nestjs/cache-manager@^3.1.0`
- `cache-manager@^7.2.8`
- `keyv@^5.6.0`
- `@keyv/redis@^5.1.6`
- `cacheable@^2.3.4`

## Articles written

Seven caching articles. Each was reshaped from the task-01 stub
(frontmatter + `Заглушка` callout) into a stand-alone
Russian-language mid-level-NestJS article that grounds every
claim in production code.

| Path                                                                                       | One-line Russian summary                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture-migration-ru/caching/cache-aside-pattern.md`                            | Cache-aside (lazy loading) от первых принципов — read/invalidate flow, post-commit-await, противопоставление write-through/read-through/write-behind. Anti-pattern «invalidate-inside-tx». Полный аудит CACHE-* (закрытые и открытые) — ~2684 слов. |
| `docs/architecture-migration-ru/caching/cache-stack-overview.md`                           | Слоистая диаграмма stack'а: `use-case → IStockCachePort → StockCache → ICachePort → RedisCacheAdapter → @nestjs/cache-manager → cache-manager → cacheable → keyv → @keyv/redis → Redis`. Per-layer breakdown ответственности. — ~1964 слов.                  |
| `docs/architecture-migration-ru/caching/lib-nestjs-cache-manager.md`                       | Nest-обёртка над cache-manager: registerAsync + CACHE_MANAGER DI-токен + CacheModuleAsyncOptions. Что **НЕ** делает: не хранит, не сериализует, не делает HTTP-cache (`CacheInterceptor` отвергнут ADR-002). — ~950 слов.                |
| `docs/architecture-migration-ru/caching/lib-cache-manager.md`                              | Façade get/set/del/wrap + multi-store dispatch. Что **НЕ** делает: не говорит с Redis, не делает SCAN, не имеет single-flight. v7+ vs v4 — переход на stores[]. — ~1021 слов.                                                          |
| `docs/architecture-migration-ru/caching/lib-keyv.md`                                       | Storage-adapter abstraction; `KeyvStoreAdapter` интерфейс с get/set/delete. Что **НЕ** делает: не Redis-клиент. Namespacing + JSON-serialization. — ~1029 слов.                                                                          |
| `docs/architecture-migration-ru/caching/lib-keyv-redis.md`                                 | Реальный Redis-клиент через `@redis/client v5+`; SCAN+UNLINK через `keyvRedis.client`. Что **НЕ** делает: не управляет namespacing'ом (это keyv), не делает Pub/Sub, нет Cluster/Sentinel-агностики. — ~1036 слов.                                  |
| `docs/architecture-migration-ru/caching/lib-cacheable.md`                                  | Multi-tier primitive под cache-manager v7+. CACHE-006 (reach-through fragility) и его закрытие ADR-016. Разделение пакет `cacheable` vs наш декоратор `@Cacheable`. — ~1164 слов.                                                            |

All seven articles flipped `status: draft` → `status: review` in
their frontmatter; `updated:` set to `2026-05-16`. Each carries
the mandatory `> [!abstract] Кратко` block, `## Глоссарий`
section, and `> [!faq]- Проверь себя` collapsible (3–5
questions per article). Every per-library article has the
**"Что этот пакет НЕ делает"** section per task-06 step 5.

Across the seven articles: **27 GitHub permalinks** pinned to
`84b1507c68fd9ee02b185eef3c4594b6fe02f664`
(8 + 5 + 3 + 2 + 2 + 4 + 3 = 27). Code anchors include all the
files suggested by task-06 step 6 plus a few that helped tell
the story:

- `libs/cache/{cache.port,cache.module,cache-module.config,cache-keys,redis-cache.adapter}.ts` — every load-bearing file in the lib.
- `libs/cache/decorators/cacheable.decorator.ts` — the decorator skeleton.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts` — the domain-shaped wrapper.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/{get-stock,reserve-stock-for-order}.use-case.ts` — read-side and invalidate-side.
- `libs/config/config-module.config.ts` (L20 — Joi `REDIS_URL`).

All cited line ranges were validated against `wc -l` of the
corresponding file at the recorded SHA — no off-by-one
corrections required this session.

## Audit status (per task-06 step 7)

The `audit-2026-05-08` items are documented in
`cache-aside-pattern.md` §«Аудит: что закрыто, что открыто».
A reader walking into the code with the `AUDIT-2026-05-08 [CACHE-N]`
markers can now match each code to live-vs-closed status:

**Closed by ADR-016 / task-11:**

- `CACHE-006` — layer reach-through fragility. Now lives in one
  file (`libs/cache/redis-cache.adapter.ts`). Discussed at
  length in `lib-cacheable.md` §«Reach-through, audit
  CACHE-006».
- `CACHE-010` — sort comparator. Closed by `localeCompare` in
  `CACHE_KEYS.inventoryStock` builder.
- `CACHE-011` — literal-`*` sentinel. Closed by non-glob
  `__all__` sentinel.
- `CACHE-012` — combo-key fallback only single-storage. No
  longer reachable; non-Redis `delByPrefix` path is a
  documented no-op.

**Still open** (live `AUDIT-2026-05-08 [CACHE-*]` comments in
code; backlog tracked):

- `CACHE-001` — read/write race / no single-flight. Comment
  in `get-stock.use-case.ts:67` and listed in `stock.cache.ts:20-25`.
- `CACHE-002` — post-commit contract enforced only by comment.
- `CACHE-003` — no schema-version segment in keys.
- `CACHE-004` — no TTL jitter.
- `CACHE-005` — duplicate warn logs on Redis-down.
- `CACHE-007` / `CACHE-008` — missing skip-cache and
  tx-failure unit coverage. Domain-test backlog.
- `CACHE-009` — no tenant segment.

Each open item is described with its current mitigation
(typically «bounded by TTL») and the suggested fix direction.
The reader is not surprised by the on-code annotation.

## Glossary terms collected

EN→RU pairs introduced across the seven articles. These get
rolled into the consolidated `glossary.md` in task-12.

| Source article                       | EN term                                | RU explanation (short)                                                                                                |
| ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| cache-aside-pattern                  | Cache-aside                            | Паттерн «app сам читает кэш и сам инвалидирует». Синоним: lazy loading. |
| cache-aside-pattern                  | Read-through                           | Кэш сам читает БД на miss'е (фасадная обёртка над cache-aside в одном API-вызове). |
| cache-aside-pattern                  | Write-through                          | Каждый write идёт в БД и в кэш синхронно. Не наш случай. |
| cache-aside-pattern                  | Write-behind                           | Write в кэш, асинхронный flush в БД. Не наш случай. |
| cache-aside-pattern                  | TTL                                    | Time-to-live; default `CACHE_TTL_MS_DEFAULT` (60000ms). |
| cache-aside-pattern                  | Ledger                                 | Append-only таблица со знаковыми дельтами. `product_stock` — ledger. |
| cache-aside-pattern                  | SCAN                                   | Команда Redis для итерации ключей по pattern'у, не блокирует. |
| cache-aside-pattern                  | UNLINK                                 | Удаление ключей Redis с async-free памяти в background-thread. |
| cache-aside-pattern                  | `delByPrefix`                          | Метод `ICachePort`. SCAN+UNLINK под капотом. |
| cache-aside-pattern                  | `CACHE_PORT`                           | DI-токен (Symbol) для `ICachePort` из `libs/cache`. |
| cache-aside-pattern                  | `CACHE_KEYS`                           | Frozen `as const`-объект builder'ов ключей. |
| cache-aside-pattern                  | `__all__`                              | Sentinel в `inventoryStock`-ключе, означающий «все storages» (не glob). |
| cache-aside-pattern                  | Graceful degradation                   | Кэш-fail логируется и проглатывается, fallback — DB. |
| cache-aside-pattern                  | Post-commit                            | Действие, выполняющееся **после** успешного COMMIT. |
| cache-aside-pattern                  | Single-flight                          | Защита от stampede: один miss делает DB-запрос, остальные ждут. |
| cache-aside-pattern                  | Schema-version segment                 | Сегмент ключа `:v2:`, инвалидирующий старые entries при breaking-change. |
| cache-aside-pattern                  | Stampede / Thundering herd             | Множество одновременных miss'ов на одном ключе → пиковая нагрузка БД. |
| cache-stack-overview                 | `Cache` (тип)                          | Класс из `cache-manager`, переэкспортированный `@nestjs/cache-manager`. |
| cache-stack-overview                 | `CACHE_MANAGER`                        | DI-токен под `Cache`. |
| cache-stack-overview                 | `Store`                                | Концепт `cache-manager v7+`/`cacheable` — один tier. |
| cache-stack-overview                 | `KeyvStoreAdapter`                     | Интерфейс keyv. Реализации: `@keyv/redis`, `@keyv/mongo`, in-memory… |
| cache-stack-overview                 | `KeyvRedis`                            | Класс `@keyv/redis`. `KeyvStoreAdapter`-имплементация over Redis. |
| cache-stack-overview                 | Reach-through                          | Структурный доступ через несколько слоёв стека. |
| cache-stack-overview                 | Multi-tier cache                       | L1 (in-process) + L2 (shared, Redis) + ...; `cacheable` это умеет. |
| cache-stack-overview                 | Namespace (keyv)                       | Prefix к каждому ключу; default — пусто. |
| cache-stack-overview                 | `keyPrefixSeparator`                   | Разделитель namespace ↔ key в keyv. |
| lib-nestjs-cache-manager             | `CacheModule` (Nest)                   | Nest-модуль из `@nestjs/cache-manager`. |
| lib-nestjs-cache-manager             | `CacheModuleAsyncOptions`              | Тип-конфиг для `CacheModule.registerAsync`. |
| lib-nestjs-cache-manager             | `CacheInterceptor`                     | HTTP-interceptor для GET-кэширования. **Не используется.** |
| lib-cache-manager                    | `wrap`                                 | Метод single-call read-through. |
| lib-cache-manager                    | `createCache`                          | Фабрика `cache-manager`'а. |
| lib-cache-manager                    | `cache.stores`                         | Массив `Keyv`-инстансов в Cache. |
| lib-keyv                             | `KeyvStoreAdapter` | Интерфейс адаптера `keyv`. Три обязательных метода: get/set/delete. |
| lib-keyv-redis                       | `@redis/client`                        | NPM-пакет; официальный Redis-клиент Node.js. |
| lib-keyv-redis                       | `RedisClient`                          | Класс из `@redis/client`. Public-property `KeyvRedis.client`. |
| lib-keyv-redis                       | `scanIterator`                         | API `@redis/client v5+`: async-iterator над SCAN. |
| lib-keyv-redis                       | `COUNT` (SCAN)                         | Hint Redis'у: «бери N ключей за iteration». |
| lib-keyv-redis                       | `RESP`                                 | REdis Serialization Protocol; wire-формат Redis. |
| lib-cacheable                        | `cacheable` (npm) | Multi-tier cache primitive под `cache-manager v7+`. |
| lib-cacheable                        | L1 / L2                                | Уровни кэша. У нас сегодня — только L2 (Redis). |
| lib-cacheable                        | `primary`                              | Историческое имя первого tier'а в `cacheable`. |
| lib-cacheable                        | `@Cacheable` (наш декоратор)           | Method-decorator-syntactic-sugar над `ICachePort.wrap`. |

Approximately **41 new pairs** introduced. Some duplicate
prior-group terms (`Post-commit`, `Graceful degradation`,
`CACHE_PORT`, `@nestjs/cache-manager` from project-shape);
task-12 will dedupe.

## Cross-references added

### Within `caching/` (peer links)

- `cache-aside-pattern` → `[[cache-stack-overview]]`, `[[lib-cacheable]]`, all `[[lib-*]]`-peers via `related:`
- `cache-stack-overview` → `[[cache-aside-pattern]]`, all `[[lib-*]]`-peers
- `lib-nestjs-cache-manager` → `[[cache-stack-overview]]`, `[[cache-aside-pattern]]`, `[[lib-cache-manager]]`, `[[lib-cacheable]]`
- `lib-cache-manager` → `[[cache-stack-overview]]`, `[[cache-aside-pattern]]`, `[[lib-nestjs-cache-manager]]`, `[[lib-cacheable]]`, `[[lib-keyv]]`
- `lib-keyv` → `[[cache-stack-overview]]`, `[[lib-cache-manager]]`, `[[lib-keyv-redis]]`, `[[lib-cacheable]]`
- `lib-keyv-redis` → `[[cache-stack-overview]]`, `[[cache-aside-pattern]]`, `[[lib-keyv]]`, `[[lib-cacheable]]`, `[[lib-cache-manager]]`
- `lib-cacheable` → `[[cache-stack-overview]]`, `[[cache-aside-pattern]]`, `[[lib-cache-manager]]`, `[[lib-keyv]]`, `[[lib-keyv-redis]]`, `[[module-boundaries]]`

Every article links to every per-group peer; reciprocal
cross-linking is maintained.

### Back to `concepts/`, `project-shape/`, `persistence/`, `messaging/` (per task-06 step 8)

- `cache-aside-pattern` → `[[hexagonal-architecture]]`, `[[shared-libs-philosophy]]`, `[[message-vs-event-patterns]]`, `[[mappers-and-repositories]]`
- `cache-stack-overview` → `[[hexagonal-architecture]]`, `[[shared-libs-philosophy]]`, `[[module-boundaries]]`
- `lib-nestjs-cache-manager` → `[[shared-libs-philosophy]]`
- `lib-cache-manager` → `[[shared-libs-philosophy]]`
- `lib-keyv` → `[[shared-libs-philosophy]]`
- `lib-keyv-redis` → `[[shared-libs-philosophy]]`
- `lib-cacheable` → `[[shared-libs-philosophy]]`, `[[module-boundaries]]`

All three back-link targets from task-06 step 8 covered:
`[[hexagonal-architecture]]` × 2, `[[shared-libs-philosophy]]` × 7,
`[[message-vs-event-patterns]]` × 1.

### Forward links into other groups

- `cache-stack-overview` → `[[trace-log-correlation]]` (observability),
  on the OTel-spans paragraph (`cache.get`, `cache.set`,
  `cache.delByPrefix` instruments). Marks the second of the
  two forward-links that `trace-log-correlation`'s eventual
  author should track (the first came from
  `routing-keys-and-contracts` in task-05).

No forward links into `auth/`, `application-layer/`, or `quality/`
were added — those groups don't need caching back-context at
this phase.

## Verification results

- [x] All seven slot files filled; no `заглушка` callouts remain
      (verified by `grep -l 'заглушка\|Заглушка' docs/architecture-migration-ru/caching/*.md` → 0 hits).
- [x] Every code excerpt has a GitHub permalink pinned to
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664`
      (**27 permalinks total**: 8 + 5 + 3 + 2 + 2 + 4 + 3).
- [x] All cited line ranges validated against `wc -l` of each
      file at the recorded SHA. No off-by-one corrections
      required this session.
- [x] Every `[[wiki-link]]` resolves to a file that exists under
      `docs/architecture-migration-ru/` (verified by enumerating
      all unique link occurrences: 13 distinct targets, all
      resolving; cross-group back-links `hexagonal-architecture`,
      `module-boundaries`, `mappers-and-repositories`,
      `message-vs-event-patterns`, `shared-libs-philosophy`,
      `trace-log-correlation` all hit existing files).
- [x] No orphans under `docs/architecture-migration-ru/` — the
      root file's `### caching/` section already links every
      stub from task-01 to all seven articles (verified
      `grep -c "\[\[<slug>\]\]" architecture-migration-guide.md`
      → 7).
- [x] Each article above the 600-word floor (smallest:
      `lib-nestjs-cache-manager.md` at **950 слов**; largest:
      `cache-aside-pattern.md` at **2684 слов**). The
      task-06 guidance was ~700 for per-library articles
      (slightly overshot — every lib-article landed between
      950 and 1164 words because the «What it does NOT do»
      section is verbose by nature).
- [x] Frontmatter valid on each touched file (`status: review`,
      `updated: 2026-05-16`, `related: [...]` populated with
      5–10 wiki-link entries).
- [x] Each article carries the mandatory `> [!abstract] Кратко`
      callout, `## Глоссарий` section, and `> [!faq]- Проверь
      себя` self-check block.
- [x] Every per-library article has the required
      **«Что этот пакет НЕ делает»** section (per task-06 §5).
      Section title varies slightly («Что этот пакет НЕ делает»
      in nestjs-cache-manager/cache-manager/keyv/keyv-redis,
      «Что этот пакет НЕ делает» в cacheable). Each section
      contains 4-9 bullet items.
- [x] All open `CACHE-*` audit items mentioned + status table:
      `CACHE-001`, `CACHE-002`, `CACHE-003`, `CACHE-004`,
      `CACHE-005`, `CACHE-007`/`CACHE-008`, `CACHE-009` listed
      as still-open; `CACHE-006`, `CACHE-010`, `CACHE-011`,
      `CACHE-012` listed as closed-by-ADR-016.
- [x] No `git` mutating commands were run during this session.

## Suggested adjustments to upcoming tasks

1. **The `trace-log-correlation` forward-link is now triple-doubled.**
   Three articles now forward-link to it: `rabbitmq-as-bus` and
   `routing-keys-and-contracts` from task-05, plus
   `cache-stack-overview` from this task (on
   the `cache.*` OTel-spans paragraph). The trace-correlation
   article — when written — should back-link to all three and
   re-derive the «one tracer, multiple sources» picture without
   repeating each group's lead-in.

2. **`message-vs-event-patterns` is now the canonical place for
   «post-commit side-effect timing».** `cache-aside-pattern`
   forward-links there for the «awaited invalidate vs
   fire-and-forget event» asymmetry. When task-10 writes
   `application-layer/use-cases-vs-fat-services.md` and
   discusses `ReserveStockForOrderUseCase` end-to-end, the
   post-commit ordering rules are already explained in two
   places — link them, don't re-derive.

3. **Audit story is now anchored in `cache-aside-pattern.md`
   §«Аудит».** When task-12 (final audit) consolidates the
   audit table, it should hoist the "closed by ADR-016 vs
   still-open" table out of `cache-aside-pattern.md` and into
   a top-level `audit.md` artefact, then cross-link back.
   The current placement is reasonable for first-read flow
   but ties audit status to one article's revision history.

4. **`lib-cacheable.md` straddles two concepts** — the NPM
   package `cacheable` and our own decorator `@Cacheable`.
   The article explicitly disambiguates them in §«lib-cacheable
   vs декоратор @Cacheable», but the file name is unfortunate.
   If task-12 audit finds reader confusion, the right fix is
   to rename the decorator (e.g. `@CachedRead`), not the
   article — the NPM package owns the «cacheable» name.

5. **The `@Cacheable` decorator is documented but not used
   anywhere.** ADR-006 §«@Cacheable» called it «optional
   read-through-sugar». If task-10's
   `application-layer/use-cases-vs-fat-services.md` finds a
   use-case that fits (e.g. `GetOrderUseCase`-style queries
   in retail), introducing `@Cacheable` to one method and
   citing this article as the reference would close a small
   discoverability gap.

6. **The shared `cache-module.config.ts` is 12 lines** —
   short enough that the entire file is cited multiple times.
   This is fine; future-task articles citing
   `cacheModuleConfig` should not re-derive the «one factory
   wires three packages» story, just link back to
   `[[cache-stack-overview]]` §«Конфиг — одна factory».

7. **No new ADRs were necessary** during this writing session.
   The seven articles document conventions already shipped
   (ADR-002, ADR-006, ADR-016, ADR-017). No architectural
   decisions were taken here.

8. **Diagram pattern.** `cache-stack-overview.md` uses a
   stack-style mermaid `flowchart TB` for the 10-layer stack.
   This format works well for "one path top-to-bottom" stories.
   If `auth-stack-overview.md` (task-07) wants the same
   silhouette, the mermaid block here is copy-paste-ready
   (just rename layers). The audit task may want to enforce
   "every stack-overview uses the same diagram style" as
   audit-time normalization.
