# _carryover-09.md — Write observability libraries (Phase: observability/, libs)

> Generated 2026-05-16 by the task-09 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-08.md` (which
> built on `_carryover-07.md` → … → `_carryover-01.md`, source of the
> SHA pin `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-08.md` was read in full first. The four observability
overview articles it produced are all on `status: review`, every
forward-link from them into `[[lib-opentelemetry-*]]`-slots is
preserved by this task's filled bodies (matching slugs verified
end-to-end), and the "what NOT to do" convention from the auth
group (§«Suggested adjustments» #1 of _carryover-08.md) has been
applied to every lib-article in this task.

No build smoke-check was run inside the session — only docs-only
files were touched under
`docs/architecture-migration-ru/observability/`. The working tree
was clean at session start; branch is `migration-guide`. No code
under `apps/` or `libs/` was modified. No `git` mutating commands
were executed.

Discrepancies check (task-01 §4): all eight clarification-group
OTel libraries are present in `package.json` at the recorded SHA
with the exact versions cited in each article:

- `@opentelemetry/api@^1.9.1`
- `@opentelemetry/sdk-node@^0.218.0`
- `@opentelemetry/auto-instrumentations-node@^0.76.0`
- `@opentelemetry/instrumentation-amqplib@^0.65.0`
- `@opentelemetry/exporter-trace-otlp-http@^0.218.0`
- `@opentelemetry/core@^2.7.1`
- `@opentelemetry/resources@^2.7.1`
- `@opentelemetry/semantic-conventions@^1.41.1`

Each version appears verbatim in the `> [!abstract] Кратко` block
of the corresponding lib-article so readers can verify against
`package.json` without leaving the file.

## Articles written

Eight per-library `@opentelemetry/*` articles. Each was reshaped
from the task-01 stub into a stand-alone Russian-language article
that grounds claims in production code (or — for transitive-only
packages — in `package.json` and the OTel-spec).

| Path | One-line Russian summary |
| ---- | ------------------------ |
| `docs/architecture-migration-ru/observability/lib-opentelemetry-api.md` | Публичная поверхность OTel: `trace`, `context`, `propagation`, `diag`. Стабильный мажор `1.x`. Без зарегистрированного SDK `getActiveSpan()` отдаёт `undefined`. Используется в `logger.module.ts` (для trace-correlation) и `tracer.ts` (для `diag`-канала). — ~1097 слов. |
| `docs/architecture-migration-ru/observability/lib-opentelemetry-sdk-node.md` | Boot-driver `NodeSDK`-агрегатор. `sdk.start()` регистрирует provider, context-manager, propagator; `sdk.shutdown()` flush'ит batch. Sane defaults: `BatchSpanProcessor`, `AlwaysOnSampler`, `AsyncLocalStorageContextManager`, W3C-propagator. Graceful SIGTERM handler. — ~1078 слов. |
| `docs/architecture-migration-ru/observability/lib-opentelemetry-auto-instrumentations-node.md` | Bundle ~30 инструментаций (http/mysql2/redis/amqplib/nestjs-core/...). `getNodeAutoInstrumentations()`. Runtime monkey-patching через `require-in-the-middle`. Зачем версия `amqplib` пин'нута top-level (детерминированность). — ~1263 слов. |
| `docs/architecture-migration-ru/observability/lib-opentelemetry-instrumentation-amqplib.md` | Load-bearing-инструментация: inject `traceparent` в `properties.headers` AMQP-сообщения на publish, extract на consume. Делает trace `gateway → retail → inventory → notification` одним деревом. Артефакт «~62s» notification-consumer span'а. — ~1316 слов. |
| `docs/architecture-migration-ru/observability/lib-opentelemetry-exporter-trace-otlp-http.md` | OTLP/HTTP exporter; POST на `:4318/v1/traces`. Почему HTTP, не gRPC и не thrift (ADR-014). Env-vars `OTEL_EXPORTER_OTLP_*`. JSON content-type. Drop-on-failure (retries — задача коллектора). — ~1144 слов. |
| `docs/architecture-migration-ru/observability/lib-opentelemetry-core.md` | Транзитивная «утилитная» библиотека: `W3CTraceContextPropagator`, `BasicTracerProvider`, `hrTime()`, `getEnv()`. App-кодом не импортируется. Явный pin в `package.json` ради Yarn-dedup'а. — ~930 слов. |
| `docs/architecture-migration-ru/observability/lib-opentelemetry-resources.md` | Builder `resourceFromAttributes(...)` для Resource-атрибутов. `service.name` + `deployment.environment.name`. Auto-detect через `resourceDetectors`. `resourceSpans`-обёртка в OTLP-payload'е. — ~1105 слов. |
| `docs/architecture-migration-ru/observability/lib-opentelemetry-semantic-conventions.md` | Plain-string-словарь канонических OTel-имён: `ATTR_SERVICE_NAME = 'service.name'`. Единственный OTel-пакет со стабильным мажором `1.x` (имена не меняются). `ATTR_*` vs deprecated `SemanticResourceAttributes.*`. Custom-атрибуты под `'app.'`. — ~1125 слов. |

All eight articles flipped `status: draft` → `status: review` in
their frontmatter; `updated:` set to `2026-05-16`. Each carries
the mandatory `> [!abstract] Кратко` block, `## Глоссарий`
section, `> [!faq]- Проверь себя` collapsible (5 questions each),
and the mandatory **`## Что этот пакет НЕ делает`** section.
Each also carries `## Что почитать дальше` with 2–3 external
references (OTel spec, package READMEs, W3C-spec where relevant).

### GitHub permalinks pinned

Across the eight articles: **16 GitHub permalinks** pinned to
`84b1507c68fd9ee02b185eef3c4594b6fe02f664`. Counts:

| Article | Permalinks |
|---------|-----------|
| `lib-opentelemetry-api.md` | 3 |
| `lib-opentelemetry-sdk-node.md` | 2 |
| `lib-opentelemetry-auto-instrumentations-node.md` | 2 |
| `lib-opentelemetry-instrumentation-amqplib.md` | 2 |
| `lib-opentelemetry-exporter-trace-otlp-http.md` | 4 |
| `lib-opentelemetry-core.md` | 1 |
| `lib-opentelemetry-resources.md` | 1 |
| `lib-opentelemetry-semantic-conventions.md` | 1 |

Code anchors:

- `libs/observability/tracer.ts` — the **central** anchor; cited
  by **seven of eight** articles (everything except `core`, which
  is transitive-only and has no app-code excerpt). Different line
  ranges per article:
  - `api`: L16-L31 (the `diag` block)
  - `sdk-node`: L1-L71 (whole file) + L57-L68 (shutdown)
  - `auto-instrumentations-node`: L17-L53 (the `NodeSDK`
    constructor)
  - `instrumentation-amqplib`: L17-L53 (same constructor)
  - `exporter-trace-otlp-http`: L18-L53 (the
    `OTLPTraceExporter()` line)
  - `resources`: L19-L46 (the `resourceFromAttributes(...)`
    block)
  - `semantic-conventions`: L21-L39 (the `[ATTR_SERVICE_NAME]`
    computed-property block)
- `libs/observability/logger.module.ts` (L3-L50 — the `trace`-import
  + `logMethod` hook body) — cited 1× in `lib-opentelemetry-api.md`
  for the `trace.getActiveSpan()` call.
- `libs/observability/spec/logger.module.spec.ts` (L1-L18 — the
  `BasicTracerProvider` + `AsyncLocalStorageContextManager` setup)
  — cited 1× in `lib-opentelemetry-api.md`.
- `docker-compose.yml` (L74-L75 — `OTEL_EXPORTER_OTLP_ENDPOINT`
  env-var) — cited 1× in `lib-opentelemetry-exporter-trace-otlp-http.md`.
- `package.json` (L55 — the `@opentelemetry/core` line) — cited
  1× in `lib-opentelemetry-core.md` (added in a post-write
  patch to put the article above zero permalinks).

All cited line ranges were validated against `wc -l` of each
file at the recorded SHA (re-using the verification table from
`_carryover-08.md` §«Word counts»). No off-by-one corrections
required this session.

### Word counts

| Article | Word count |
|---------|-----------|
| `lib-opentelemetry-api.md` | 1097 |
| `lib-opentelemetry-sdk-node.md` | 1078 |
| `lib-opentelemetry-auto-instrumentations-node.md` | 1263 |
| `lib-opentelemetry-instrumentation-amqplib.md` | 1316 |
| `lib-opentelemetry-exporter-trace-otlp-http.md` | 1144 |
| `lib-opentelemetry-core.md` | 930 |
| `lib-opentelemetry-resources.md` | 1105 |
| `lib-opentelemetry-semantic-conventions.md` | 1125 |
| **Total** | **9 058** |

Task-09 §«Article slots to fill» suggested ~700–1000 words per
article. All eight came in **above** that range (930 — the
smallest, `lib-opentelemetry-core`; 1316 — the largest,
`lib-opentelemetry-instrumentation-amqplib`). The overshoot is
consistent with the pattern of the previous two clarification
groups (cache-stack task-06 → median ~600–800 → actual
~900–1200; auth-stack task-07 → suggested ~600–700 → actual
928–1459). The "what NOT to do" + glossary + self-check
overhead pushes every per-library article ~300–400 words above
the body-content target.

`lib-opentelemetry-instrumentation-amqplib.md` (1316 — the
largest) is the **most consequential** library in the stack:
without it, the four-service trace falls apart. The article
goes deep on inject/extract mechanics, `amqp-connection-manager`
wrapper transparency, and the `~62s` artifact. Task-08
§«Suggested adjustments» #2 explicitly called for this article
to get the richest treatment; that suggestion is honoured.

`lib-opentelemetry-core.md` (930 — the smallest) is allowed
by task-09 §«Verification» (`adapter-thin articles like
lib-opentelemetry-core may sit at the floor`). The article
explains the package's transitive role and why it's still
pinned top-level.

## Audit status

No new audit items opened by this session. The known artefact
«notification-consumer span ~62s» is referenced from
`lib-opentelemetry-instrumentation-amqplib.md` § «Что особенного
в version `0.65.0`» — readers seeing this in Jaeger UI now
have two distinct articles to land on (this one and
`jaeger-backend.md` §«Артефакт»). Cross-link is bilateral.

The deferred follow-up from `_carryover-08.md` §«Suggested
adjustments» #4 (the `OTEL_SDK_DISABLED=true` test-context
explanation belongs in `[[test-strategy]]`) is preserved for
task-11 to honour.

## Glossary terms collected

EN→RU pairs introduced across the eight articles. These get
rolled into the consolidated `glossary.md` in task-12.
**Approximately 100 new pairs** introduced across the group;
many overlap with the four overview articles from task-08 and
will be deduped in task-12.

Key new terms (not yet defined elsewhere):

| Source article | EN term | RU explanation (short) |
| -------------- | ------- | ---------------------- |
| lib-opentelemetry-api | `Tracer` (interface) | Объект, возвращаемый `trace.getTracer(...)`. |
| lib-opentelemetry-api | `TracerProvider` | Интерфейс: фабрика Tracer'ов. Реализуется SDK или test-stub'ами. |
| lib-opentelemetry-api | `ContextManager` | Интерфейс: «как async-контекст хранится». Прод-реализация — `AsyncLocalStorageContextManager`. |
| lib-opentelemetry-api | No-op-span | Span без provider'а; попадает в /dev/null. |
| lib-opentelemetry-sdk-node | `BatchSpanProcessor` | Default-processor SDK: буферизует span'ы. |
| lib-opentelemetry-sdk-node | `SimpleSpanProcessor` | Альтернатива: один span = один экспорт. |
| lib-opentelemetry-sdk-node | `AlwaysOnSampler` | Default-sampler: 100% sampling. |
| lib-opentelemetry-sdk-node | Graceful shutdown | Гарантирует, что финальные span'ы успеют покинуть процесс. |
| lib-opentelemetry-auto-instrumentations-node | Runtime monkey-patching | Подмена экспортов модуля в момент `require()`. |
| lib-opentelemetry-auto-instrumentations-node | `instrumentation-http` / `mysql2` / `redis` / `nestjs-core` / `fs` | Конкретные patch-пакеты внутри bundle'а. |
| lib-opentelemetry-instrumentation-amqplib | `publish`-span / `process`-span | Span'ы на стороне producer'а / consumer'а в AMQP. |
| lib-opentelemetry-instrumentation-amqplib | `Channel.ack` / `Channel.nack` | Методы amqplib, закрывающие `process`-span. |
| lib-opentelemetry-instrumentation-amqplib | Version pin | Явная top-level-зависимость для контроля версии. |
| lib-opentelemetry-exporter-trace-otlp-http | `OTLPTraceExporter` | Класс exporter'а. Конструктор без аргументов = читать env-vars. |
| lib-opentelemetry-exporter-trace-otlp-http | `OTEL_EXPORTER_OTLP_HEADERS` / `TIMEOUT` / `COMPRESSION` | Доп-env-vars exporter'а. |
| lib-opentelemetry-exporter-trace-otlp-http | OTLP/JSON | JSON-сериализация. Что использует этот пакет. |
| lib-opentelemetry-exporter-trace-otlp-http | OTLP/protobuf | Бинарная сериализация. Отдельный пакет. |
| lib-opentelemetry-exporter-trace-otlp-http | `resourceSpans` | Внешняя обёртка JSON-payload'а. |
| lib-opentelemetry-core | `W3CTraceContextPropagator` | Реализация W3C `traceparent`/`tracestate` inject/extract. |
| lib-opentelemetry-core | `W3CBaggagePropagator` | Реализация W3C-baggage. |
| lib-opentelemetry-core | `CompositePropagator` | Комбинатор propagator'ов. |
| lib-opentelemetry-core | `BasicTracerProvider` | Минимальный provider для тестов. |
| lib-opentelemetry-core | `hrTime()` | High-resolution timestamp helper. |
| lib-opentelemetry-core | Транзитивная зависимость | Зависимость через другую зависимость, без явного pin'а. |
| lib-opentelemetry-core | Yarn dedup | Сворачивание нескольких versions одного пакета в одну. |
| lib-opentelemetry-resources | `resourceFromAttributes(...)` | Builder-функция. |
| lib-opentelemetry-resources | Resource detectors | Пакеты, авто-детектирующие атрибуты из окружения. |
| lib-opentelemetry-resources | Per-service Resource | Не пропагируется между сервисами. |
| lib-opentelemetry-semantic-conventions | Semantic conventions | OTel-spec, определяющий правильные имена атрибутов. |
| lib-opentelemetry-semantic-conventions | `ATTR_SERVICE_NAME` / `ATTR_HTTP_REQUEST_METHOD` / `ATTR_DB_SYSTEM` / `ATTR_MESSAGING_SYSTEM` | Константы канонических имён. |
| lib-opentelemetry-semantic-conventions | Canonical name vs custom attribute | Canonical — из OTel-spec'а; custom — domain-имя под `'app.'`-префиксом. |
| lib-opentelemetry-semantic-conventions | Tree-shaking | Bundler-оптимизация: убирает неиспользуемые экспорты. |
| lib-opentelemetry-semantic-conventions | `SemanticResourceAttributes` (deprecated) | Старый namespace-style; alias на новые `ATTR_*`. |

## Cross-references added

### Within `observability/` (sibling links)

Each lib-article links to the two-three siblings most commonly
confused with it (task-09 §6):

- `lib-opentelemetry-api` ↔ `lib-opentelemetry-sdk-node` ↔
  `lib-opentelemetry-core` — the three layers of "what
  registers the active span"; reciprocal cross-linking.
- `lib-opentelemetry-auto-instrumentations-node` ↔
  `lib-opentelemetry-instrumentation-amqplib` — bundle and the
  one library it contains that the project pins explicitly;
  reciprocal cross-linking.
- `lib-opentelemetry-core` ↔ `lib-opentelemetry-resources` —
  both supporting utilities; reciprocal cross-linking.
- `lib-opentelemetry-resources` ↔ `lib-opentelemetry-semantic-conventions`
  — builder and the dictionary of names it consumes;
  reciprocal cross-linking.

All eight articles link to `[[opentelemetry-overview]]` and
`[[jaeger-backend]]` in their `related:` block (task-09 §6).
Most link to `[[lib-opentelemetry-api]]` (the public surface
they ultimately serve) and `[[lib-opentelemetry-sdk-node]]`
(the boot driver that wires them in).

### Forward-links from overview articles now resolve

Per `_carryover-08.md` §«Forward-links to `lib-opentelemetry-*`»,
the eight overview-side forward-links from `opentelemetry-overview.md`
all resolve to filled articles. `trace-log-correlation.md` and
`jaeger-backend.md` adds also resolve. **Zero orphan slugs in
the observability group**.

### Back-links from observability into earlier groups

Required by task-09 step 6 + earlier conventions; all covered:

- `[[opentelemetry-overview]]` and `[[jaeger-backend]]` —
  referenced by **all 8** lib-articles.
- `[[trace-log-correlation]]` — not referenced by lib-articles
  (these are component-level; trace-log-correlation is an
  application-level pattern that uses `@opentelemetry/api`).
- `[[pino-logging]]` — not referenced by lib-articles for the
  same reason.
- `[[rabbitmq-as-bus]]` — referenced by
  `lib-opentelemetry-auto-instrumentations-node.md` and
  `lib-opentelemetry-instrumentation-amqplib.md` (the AMQP
  story).
- `[[nest-microservices-transport]]` — referenced by
  `lib-opentelemetry-instrumentation-amqplib.md`.
- `[[message-vs-event-patterns]]` — referenced by
  `lib-opentelemetry-instrumentation-amqplib.md`.
- `[[routing-keys-and-contracts]]` — referenced by
  `lib-opentelemetry-instrumentation-amqplib.md`.

### Root file's TOC

`docs/architecture-migration-ru/architecture-migration-guide.md`
already lists all eight `lib-opentelemetry-*` slugs in its
`### observability/` section (verified at L148-L155;
populated by task-01's scaffolding). No edits to the root file
required this session.

## Verification results

- [x] All eight slot files filled; no `заглушка` callouts
      remain (verified by
      `grep -l 'заглушка\|Заглушка' docs/architecture-migration-ru/observability/lib-opentelemetry-*.md`
      → 0 hits).
- [x] Every code excerpt has a GitHub permalink pinned to
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664`
      (**16 permalinks total**: 3 + 2 + 2 + 2 + 4 + 1 + 1 + 1).
- [x] Each per-library article has the required
      **«Что этот пакет НЕ делает»** section (verified by
      `grep -c '^## Что этот пакет НЕ делает'` → 1 per file).
- [x] Every `[[wiki-link]]` resolves to a file that exists
      under `docs/architecture-migration-ru/` (verified by
      enumerating distinct targets):
      - Within `observability/`: 4 overviews (task-08) + 8
        lib-articles (this task). All reciprocally linked.
      - Cross-group: `[[hexagonal-architecture]]`,
        `[[shared-libs-philosophy]]`, `[[rabbitmq-as-bus]]`,
        `[[nest-microservices-transport]]`,
        `[[message-vs-event-patterns]]`,
        `[[routing-keys-and-contracts]]` — all hit existing
        files (filled by tasks 02 / 03 / 05).
- [x] No orphans under `docs/architecture-migration-ru/`
      observability subtree.
- [x] Each article at or above the 600-word floor (smallest:
      `lib-opentelemetry-core.md` at **930 слов** —
      explicitly allowed by task-09 §«Verification» as
      adapter-thin; largest: `lib-opentelemetry-instrumentation-amqplib.md`
      at **1316 слов**; median across the 8 articles is
      ~1110 слов).
- [x] Frontmatter valid on each touched file (`status: review`,
      `updated: 2026-05-16`, `related: [...]` populated with
      6–8 wiki-link entries each).
- [x] Each article carries the mandatory `> [!abstract] Кратко`
      callout, `## Глоссарий` section, and `> [!faq]- Проверь
      себя` self-check block (5 questions each).
- [x] No `git` mutating commands were run during this session.

## Suggested adjustments to upcoming tasks

1. **The observability clarification group is now COMPLETE**
   (12 articles: 4 overviews + 8 libs). All forward-links
   from task-08's overview articles resolve. Task-09 closes
   the group. Audit time in task-12 will mostly involve
   deduplication of glossary entries between overviews and
   libs.

2. **`tracer.ts` is now cited by 7 of 8 lib-articles** plus
   `opentelemetry-overview.md`. That's 8 distinct articles
   referencing **one** 71-line file. This file has the
   highest reference-per-LOC density in the guide so far.
   `_carryover-08.md` §«Suggested adjustments» #8 already
   flagged `logger.module.ts` as a similar load-bearing
   file; `tracer.ts` joins it. Task-12 audit may consider a
   one-table «files cited by ≥5 articles» index.

3. **The `ATTR_*` vs `SemanticResourceAttributes.*`
   deprecation note** is in `lib-opentelemetry-semantic-conventions.md`.
   If someone later refactors `tracer.ts` to use either,
   the article gives the why. Worth keeping if `tracer.ts`
   is ever revised — the choice was non-obvious in upstream.

4. **`@opentelemetry/instrumentation-amqplib` is the most
   important article in the stack** (per task-08
   §«Suggested adjustments» #2). It carries the deepest
   walk-through. If task-12 audit wants to add a «featured
   articles» pointer in the root, this is a natural
   candidate alongside `cache-stack-overview.md` and
   `auth-stack-overview.md`.

5. **Versions cited in the article abstracts** anchor each
   article to a specific `^x.y.z` from `package.json` at
   the recorded SHA. When yarn picks up a minor bump on
   `yarn install` (e.g. `0.218.0 → 0.219.0`), the article
   abstracts stay accurate (the `^` syntax is documented in
   `lib-opentelemetry-core.md`'s FAQ). Mismatch in mid-2027
   would be a signal for re-audit.

6. **No new ADRs were necessary** during this writing
   session. The eight articles document conventions already
   shipped (ADR-007, ADR-014, ADR-015). No architectural
   decisions were taken.

7. **`OTEL_DIAG_LOG_LEVEL` env-var** is documented in
   `lib-opentelemetry-api.md` (§ «Where the library is
   used») but not in the root `architecture-migration-guide.md`
   nor in `libs/config/config-module.config.ts`'s Joi schema.
   This is a debug-only var, so it doesn't need Joi
   validation; but if task-12 audit wants to enumerate
   _every_ OTel-env-var in one place, the canonical list is
   in `tracer.ts` comments.

8. **Forward-links from observability/ into application-layer/
   are now possible** — when task-10 writes `use-cases-vs-fat-services.md`,
   it can cite our 8 lib-articles as «here's what's behind
   `trace.getActiveSpan()`» and back-link to
   `[[lib-opentelemetry-api]]`. No back-links from current
   articles are needed; the trajectory is unilateral.

9. **The notification-consumer ~62s artefact is now
   triple-documented**: in `jaeger-backend.md` (task-08), in
   `lib-opentelemetry-instrumentation-amqplib.md` (this
   task), and indirectly in `_carryover-10.md` §8 #3 of the
   migration plan. The three pointers are mutually
   reciprocal. If a future task wants to add a fourth (e.g.
   a screenshot guide), it must back-link to all three.

10. **`@opentelemetry/context-async-hooks`** is mentioned
    in `lib-opentelemetry-api.md` and `lib-opentelemetry-sdk-node.md`
    as the source of `AsyncLocalStorageContextManager`, but
    it's NOT in our top-level `package.json` (it's
    transitive). No dedicated article was warranted — it's
    a single class, mentioned ~3 times across the group.
    Task-12 audit may note this as «one transitive package
    we mention but don't have a dedicated article for; OK
    as is».
