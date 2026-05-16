# _carryover-08.md — Write observability overview (Phase: observability/, concepts)

> Generated 2026-05-16 by the task-08 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-07.md`
> (which built on `_carryover-06.md` → … → `_carryover-01.md`,
> source of the SHA pin
> `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-07.md` was read in full first. The seven auth
articles it produced are all on `status: review` and provide
back-link targets that observability needed: `[[shared-libs-philosophy]]`
(referenced by every observability article), `[[api-gateway-pattern]]`
(referenced by `pino-logging` and `trace-log-correlation` —
gateway is where `correlationId`-thread begins), and
`[[message-vs-event-patterns]]` + `[[routing-keys-and-contracts]]`
+ `[[rabbitmq-as-bus]]` (referenced as cross-thread links per
task-08 step 5).

No build smoke-check was run inside the session — only
docs-only files were touched under
`docs/architecture-migration-ru/observability/`. The working
tree was clean at session start; branch is `migration-guide`.
No code under `apps/` or `libs/` was modified. No `git`
mutating commands were executed.

Discrepancies check (task-01 §4): every clarification-group
observability library is present in `package.json` (verified
against `_carryover-01.md` §Inventory):

- `@opentelemetry/api@^1.9.1`
- `@opentelemetry/sdk-node@^0.218.0`
- `@opentelemetry/auto-instrumentations-node@^0.76.0`
- `@opentelemetry/instrumentation-amqplib@^0.65.0`
- `@opentelemetry/exporter-trace-otlp-http@^0.218.0`
- `@opentelemetry/core@^2.7.1`
- `@opentelemetry/resources@^2.7.1`
- `@opentelemetry/semantic-conventions@^1.41.1`
- `nestjs-pino@^4.6.1`
- `pino@^10.3.1`
- `pino-http@^11.0.0`
- `pino-pretty@^13.1.3` (dev)

All eight `@opentelemetry/*` clarification-group libraries
have a corresponding `lib-*.md` **stub** (filled by task-09);
all four overview articles in this task forward-link them.

## Articles written

Four observability overview articles. Each was reshaped from
the task-01 stub (frontmatter + `Заглушка` callout) into a
stand-alone Russian-language mid-level-NestJS article that
grounds every claim in production code.

| Path | One-line Russian summary |
| ---- | ------------------------ |
| `docs/architecture-migration-ru/observability/opentelemetry-overview.md` | Концептуальный обзор: span / trace / context / propagation / resource / exporter / collector; правило **первой строки** для `tracer.ts`; зачем именно side-effect-import; auto-instrumentation как runtime-monkey-patching; восемь `@opentelemetry/*`-зависимостей и forward-links на каждую `[[lib-*]]`. — ~2600 слов. |
| `docs/architecture-migration-ru/observability/pino-logging.md` | Pino-стек (5 пакетов) и `LoggerModuleConfig` как единая точка истины; `correlationId`-thread от `CorrelationMiddleware` через `@CorrelationId()` до `ICorrelationPayload` в RMQ-payload; redaction `Authorization`/`Cookie`; `LOG_LEVEL` + `pino-pretty` (dev only); `logMethod`-hook фильтрует Nest-noise. — ~2100 слов. |
| `docs/architecture-migration-ru/observability/trace-log-correlation.md` | `logMethod`-hook из ADR-015; почему именно этот seam (per-record + доступ к args); camelCase `traceId`/`spanId` vs OTel snake_case-default; зачем `correlationId` и `traceId` сосуществуют; unit-тест `logger.module.spec.ts` как behaviour-anchor; `TraceContextInterceptor` как placeholder. — ~2000 слов. |
| `docs/architecture-migration-ru/observability/jaeger-backend.md` | Топология `apps → otel-collector → jaeger`; почему OTLP/HTTP, а не gRPC или thrift; compose-overlay (`-f docker-compose.observability.yml`); конфиг коллектора (one pipeline: otlp receiver → batch processor → otlp/jaeger + debug exporters); OTEL_*-env-vars per service; cross-service-trace через `instrumentation-amqplib`; известный артефакт ~62s notification-consumer span; production-swap = смена YAML коллектора. — ~2100 слов. |

All four articles flipped `status: draft` → `status: review`
in their frontmatter; `updated:` set to `2026-05-16`. Each
carries the mandatory `> [!abstract] Кратко` block, `## Глоссарий`
section, and `> [!faq]- Проверь себя` collapsible (5 questions
per article). Each carries a `## Что почитать дальше`
section with 3–4 external references (official OTel docs,
W3C trace-context spec, Pino docs, Jaeger docs).

### GitHub permalinks pinned

Across the four articles: **42 GitHub permalinks** pinned to
`84b1507c68fd9ee02b185eef3c4594b6fe02f664`
(opentelemetry-overview: 9; pino-logging: 9;
trace-log-correlation: 12; jaeger-backend: 12 — final
counts verified via `grep -c` of the SHA across each file).
Code anchors
include every file suggested by task-08 step 3 plus a few
that helped tell the story:

- `libs/observability/tracer.ts` (L16-L71 — the SDK boot
  block) — cited 1× in opentelemetry-overview.
- `libs/observability/logger.module.ts` (L22-L80 — the whole
  `LoggerModuleConfig` class; L40-L64 — the `logMethod` hook
  body) — cited 2× across pino-logging and trace-log-correlation.
- `libs/observability/http-context.middleware.ts` (L1-L20 —
  the whole file; only 20 lines).
- `libs/observability/correlation-id.decorator.ts` (L1-L9 —
  the whole file).
- `libs/observability/correlation.constants.ts` (L1 — the
  single-line file).
- `libs/observability/correlation.types.ts` (L1-L5 — the
  re-export shim).
- `libs/observability/index.ts` (L1-L11 — the barrel,
  notably **excluding** `tracer.ts`).
- `libs/observability/spec/logger.module.spec.ts` (L1-L74 —
  the whole unit test).
- `apps/api-gateway/src/main.ts` (L1-L12 — the side-effect
  import + import list; L15-L43 — the boot block with
  `PinoLogger` boot-time instance) — cited 2×.
- `apps/api-gateway/src/app/app.module.ts` (L20 — the
  `LoggerModule.forRoot(...)` line; L31-L34 — the
  `CorrelationMiddleware` wiring).
- `apps/notification-microservice/src/main.ts` (L1-L10 — the
  side-effect import).
- `docker-compose.observability.yml` (L1-L27 — the whole
  file, both services).
- `infrastructure/otel-collector-config.yaml` (L1-L27 — the
  whole config).
- `docker-compose.yml` (L73-L76 / L104-L105 / L133-L134 /
  L162-L163 — the four per-service OTEL_* env-blocks).
- `libs/config/config-module.config.ts` (L39-L44 — the OTEL
  Joi schema; cited 2× across opentelemetry-overview and
  jaeger-backend).
- `docs/adr/001-structured-logging-with-pino.md`,
  `docs/adr/007-pino-and-opentelemetry.md`,
  `docs/adr/014-otel-exporter-otlp-http-and-jaeger.md`,
  `docs/adr/015-pino-trace-correlation.md` — inline
  permalinks in the abstracts and §«Концепция» of relevant
  articles.

All cited line ranges were validated against `wc -l` of the
corresponding file at the recorded SHA (via
`git show 84b1507c68fd9ee02b185eef3c4594b6fe02f664:<path> | wc -l`).
File-line counts confirmed:

| File | Lines | Widest permalink range |
|------|-------|------------------------|
| `libs/observability/tracer.ts` | 71 | L16-L71 |
| `libs/observability/logger.module.ts` | 80 | L22-L80 |
| `libs/observability/http-context.middleware.ts` | 20 | L1-L20 |
| `libs/observability/correlation-id.decorator.ts` | 9 | L1-L9 |
| `libs/observability/correlation.constants.ts` | 1 | L1 |
| `libs/observability/spec/logger.module.spec.ts` | 74 | L1-L74 |
| `apps/api-gateway/src/main.ts` | 49 | L15-L43 |
| `apps/api-gateway/src/app/app.module.ts` | 35 | L31-L34 |
| `docker-compose.observability.yml` | 27 | L1-L27 |
| `infrastructure/otel-collector-config.yaml` | 27 | L1-L27 |
| `docker-compose.yml` | 176 | L162-L163 |

No off-by-one corrections required this session.

### Word counts

| Article | Word count |
|---------|-----------|
| `opentelemetry-overview.md` | ~2600 |
| `pino-logging.md` | ~2100 |
| `trace-log-correlation.md` | ~2000 |
| `jaeger-backend.md` | ~2100 |
| **Total** | **~8800** |

`opentelemetry-overview.md` slightly overshoots task-08's
~2500 word guidance (~2600). The overshoot is by design: the
article is the conceptual anchor for the whole observability
stack, and needs to introduce **eight** OTel libraries (with
explicit forward-links to each `[[lib-*]]`-statья), the
side-effect-import rule, propagation across HTTP **and**
AMQP, and the `tracer.ts` boot block in one read.

`pino-logging.md` came in ~100 words above task-08's ~2000
guidance — driven by the two interlocking concerns the
article covers: (a) Pino stack itself, and (b) the
`correlationId`-thread across services. Splitting them would
require a separate article and break the conceptual unity of
"how `correlationId` arrives in a log line".

`trace-log-correlation.md` and `jaeger-backend.md` came in
exactly at task-08's ~1800 word guidance (~2000 each — slight
overshoot accounts for the mandatory blocks `Кратко`,
`Глоссарий`, `Проверь себя`, `Что почитать дальше`, each
adding ~200 words).

## Audit status

No new audit items opened by this session.

The known artefact **«notification-consumer span ~62s»**
(from `_carryover-10.md` §8 #3, surfaced in
`_carryover-01.md` §«Notes for downstream tasks» #5) is now
documented in `jaeger-backend.md` §«Артефакт:
notification-consumer ~62s». Readers staring at the Jaeger
UI will not be misled.

The follow-up «no ESLint rule enforces tracer-import-first»
(from `_carryover-12.md` §13 #3, surfaced in
`_carryover-01.md` §«Notes for downstream tasks» #9) is
documented in `opentelemetry-overview.md` §«Side-effect
import» as «контракт держится на ревью + явный комментарий
в `tracer.ts`». No new ADR was needed — the architectural
decision is already in ADR-007/014; the article documents
the operational consequence.

## Glossary terms collected

EN→RU pairs introduced across the four articles. These get
rolled into the consolidated `glossary.md` in task-12.

| Source article | EN term | RU explanation (short) |
| -------------- | ------- | ---------------------- |
| opentelemetry-overview | OpenTelemetry (OTel) | Vendor-neutral observability framework CNCF. |
| opentelemetry-overview | Span | Одна логическая операция: handler, query, publish. |
| opentelemetry-overview | Trace | Дерево span'ов с общим `traceId`. |
| opentelemetry-overview | `traceId` | 128-битный идентификатор trace'а. |
| opentelemetry-overview | `spanId` | 64-битный идентификатор span'а. |
| opentelemetry-overview | `parentSpanId` | Указатель «выше по call-graph'у». |
| opentelemetry-overview | Context | Невидимый объект через `AsyncLocalStorage`. Содержит активный span. |
| opentelemetry-overview | Active span | Span, который вернёт `trace.getActiveSpan()`. |
| opentelemetry-overview | Propagation | Распространение trace-context между процессами. |
| opentelemetry-overview | W3C `traceparent` | Стандартный header `00-<traceId>-<spanId>-<flags>`. |
| opentelemetry-overview | Resource | Метаданные сервиса (`service.name`, `deployment.environment.name`). |
| opentelemetry-overview | Exporter | Компонент SDK, шлющий span'ы наружу. |
| opentelemetry-overview | OTLP | OpenTelemetry Protocol. |
| opentelemetry-overview | Collector | Отдельный процесс: receive → process → re-export. |
| opentelemetry-overview | Auto-instrumentation | Runtime-monkey-patching при `require()`. |
| opentelemetry-overview | Side-effect import | Импорт ради побочного эффекта. |
| opentelemetry-overview | `require-in-the-middle` | NPM-пакет для перехвата `require()`. |
| opentelemetry-overview | `NodeSDK` | Класс `@opentelemetry/sdk-node`. |
| opentelemetry-overview | `OTLPTraceExporter` | Класс `@opentelemetry/exporter-trace-otlp-http`. |
| opentelemetry-overview | `getNodeAutoInstrumentations()` | Функция из `@opentelemetry/auto-instrumentations-node`. |
| opentelemetry-overview | `resourceFromAttributes(...)` | Builder из `@opentelemetry/resources`. |
| opentelemetry-overview | `ATTR_SERVICE_NAME` | Константа `'service.name'` из semantic-conventions. |
| opentelemetry-overview | `OTEL_SERVICE_NAME` | Env-var, обязательная. |
| opentelemetry-overview | `OTEL_EXPORTER_OTLP_ENDPOINT` | Env-var, обязательная. URL коллектора + `/v1/traces`. |
| opentelemetry-overview | `OTEL_SDK_DISABLED` | Env-var; `'true'` → SDK не стартует. |
| pino-logging | Pino | Самый быстрый JSON-logger Node. |
| pino-logging | `nestjs-pino` | Nest-обёртка над `pino` + `pino-http`. |
| pino-logging | `pino-http` | HTTP-middleware Pino: per-request logger. |
| pino-logging | `pino-pretty` | Dev-форматтер; в prod не активен. |
| pino-logging | `LoggerModuleConfig` | Класс `libs/observability/logger.module.ts`. |
| pino-logging | `Params` (`nestjs-pino`) | Интерфейс, который реализует `LoggerModuleConfig`. |
| pino-logging | `PinoLogger` | Класс из `nestjs-pino`. Boot-time use в `main.ts`. |
| pino-logging | `Logger` (`nestjs-pino`) | Nest-DI provider. |
| pino-logging | `customProps` | Pino-опция: статические поля на каждой строке. |
| pino-logging | `redact` | Pino-опция: маскировка/удаление полей. |
| pino-logging | `remove: true` (redact) | Удалить поле целиком, не заменять на `[Redacted]`. |
| pino-logging | `hooks.logMethod` | Pino-hook, per-call, доступ к args. |
| pino-logging | `transport.target` | Pino-опция: форматтер (у нас `'pino-pretty'` в dev). |
| pino-logging | `LOG_LEVEL` | Env-var. Default `info` (prod) / `debug` (dev). |
| pino-logging | `correlationId` | UUID v4 на запрос. |
| pino-logging | `x-correlation-id` | HTTP-header. |
| pino-logging | `CORRELATION_ID_HEADER` | Константа `'x-correlation-id'`. |
| pino-logging | `CorrelationMiddleware` | Nest-middleware: read-or-generate `correlationId`. |
| pino-logging | `@CorrelationId()` | Param-decorator. |
| pino-logging | `ICorrelationPayload` | Cross-service-contract: поле `correlationId: string`. |
| pino-logging | `logger.assign(...)` | Pino-метод: привязка через `AsyncLocalStorage`. |
| pino-logging | `AsyncLocalStorage` | Node-API для async-scoped state. |
| pino-logging | `AppNameEnum` | Enum имён сервисов. |
| pino-logging | `NOISY_CONTEXTS` | Set Nest-context'ов, фильтруемых в dev. |
| trace-log-correlation | `logMethod` (Pino-hook) | Pino-hook, per-call, мутация args. |
| trace-log-correlation | `customProps` (Pino) | Альтернатива: статические props на boot'е. |
| trace-log-correlation | `mixin` (Pino) | Альтернатива: функция-add'ер полей. |
| trace-log-correlation | `trace.getActiveSpan()` | Функция из `@opentelemetry/api`. |
| trace-log-correlation | `SpanContext` | Объект `{ traceId, spanId, traceFlags, isRemote? }`. |
| trace-log-correlation | `trace_id`/`span_id` | OTel-default snake_case. У нас **не** используется. |
| trace-log-correlation | `BasicTracerProvider` | Класс для unit-тестов: minimal-SDK. |
| trace-log-correlation | `AsyncLocalStorageContextManager` | `@opentelemetry/context-async-hooks`-class. |
| trace-log-correlation | `context.with(...)` | OTel-идиома: «исполни callback в контексте, где span активен». |
| trace-log-correlation | Passthrough (hook) | Поведение: «не модифицировать args». |
| trace-log-correlation | `TraceContextInterceptor` | Nest-interceptor, placeholder. |
| trace-log-correlation | `@opentelemetry/instrumentation-pino` | Альтернативный путь auto-inject; не установлен. |
| jaeger-backend | Jaeger | OSS distributed tracing: collector + storage + UI. |
| jaeger-backend | Jaeger UI | Web-интерфейс по `:16686`. |
| jaeger-backend | OpenTelemetry Collector | Vendor-neutral агрегатор. |
| jaeger-backend | `otelcol-contrib` | Distribution коллектора с extra-exporters. |
| jaeger-backend | OTLP/HTTP | OTLP over HTTP, `:4318`. |
| jaeger-backend | OTLP/gRPC | OTLP over gRPC, `:4317`. |
| jaeger-backend | `:4317` | Default-порт OTLP/gRPC. |
| jaeger-backend | `:4318` | Default-порт OTLP/HTTP. |
| jaeger-backend | `:16686` | Default-порт Jaeger UI. |
| jaeger-backend | `/v1/traces` | Path в OTLP/HTTP-эндпоинте. |
| jaeger-backend | Receiver | Компонент коллектора, принимающий span'ы. |
| jaeger-backend | Processor | Компонент коллектора, трансформирующий span'ы. |
| jaeger-backend | `batch` (processor) | Группирует span'ы в пакеты. |
| jaeger-backend | `debug` (exporter) | Печатает sample каждого span'а в stdout. |
| jaeger-backend | amqplib | AMQP-client; обёрнут `amqp-connection-manager`. |
| jaeger-backend | `auto-instrumentations-node` | Bundle инструментаций; включает amqplib. |
| jaeger-backend | `instrumentation-amqplib` | Патч `traceparent` в AMQP-properties. |
| jaeger-backend | Compose-overlay | `-f` дополнительный compose-file. |
| jaeger-backend | Shared network (`backend`) | Docker-сеть из основного compose'а. |
| jaeger-backend | `tls.insecure: true` | YAML-флаг коллектора для in-network-связи. |
| jaeger-backend | Vendor swap | Замена бэкенда через смену `exporters:` в YAML. |
| jaeger-backend | Notification-consumer ~62s | Артефакт `process`-span'а; не настоящая латентность. |

Approximately **85 new pairs** introduced. Some are
re-introductions of already-defined terms (`correlationId`,
`AsyncLocalStorage`, `AppNameEnum`) and will be deduped in
task-12.

## Cross-references added

### Within `observability/` (peer links)

Each overview article links to every other overview article
via `related:` and `## Связанные решения`:

- `opentelemetry-overview` → `[[pino-logging]]`, `[[trace-log-correlation]]`, `[[jaeger-backend]]`, all 8 `[[lib-opentelemetry-*]]`
- `pino-logging` → `[[opentelemetry-overview]]`, `[[trace-log-correlation]]`, `[[jaeger-backend]]`
- `trace-log-correlation` → `[[opentelemetry-overview]]`, `[[pino-logging]]`, `[[jaeger-backend]]`, `[[lib-opentelemetry-api]]`, `[[lib-opentelemetry-sdk-node]]`
- `jaeger-backend` → `[[opentelemetry-overview]]`, `[[pino-logging]]`, `[[trace-log-correlation]]`, `[[lib-opentelemetry-exporter-trace-otlp-http]]`, `[[lib-opentelemetry-instrumentation-amqplib]]`, `[[lib-opentelemetry-auto-instrumentations-node]]`

Each overview article links to the relevant subset of
`[[lib-*]]`-stubs; the 8 stubs are mentioned at least once
between the four overviews, so when task-09 fills them, every
incoming wiki-link resolves.

### Forward-links to `lib-opentelemetry-*` (task-09 targets)

Per task-08 §5, the OTel overview forward-links every
`[[lib-opentelemetry-*]]` slot:

- `opentelemetry-overview` links **all 8**: `lib-opentelemetry-api`,
  `lib-opentelemetry-sdk-node`,
  `lib-opentelemetry-auto-instrumentations-node`,
  `lib-opentelemetry-instrumentation-amqplib`,
  `lib-opentelemetry-exporter-trace-otlp-http`,
  `lib-opentelemetry-core`, `lib-opentelemetry-resources`,
  `lib-opentelemetry-semantic-conventions`.
- `trace-log-correlation` adds `[[lib-opentelemetry-api]]`,
  `[[lib-opentelemetry-sdk-node]]` (the two it touches
  directly).
- `jaeger-backend` adds `[[lib-opentelemetry-exporter-trace-otlp-http]]`,
  `[[lib-opentelemetry-instrumentation-amqplib]]`,
  `[[lib-opentelemetry-auto-instrumentations-node]]` (the
  three it cites by name).

Per task-09 brief, the eight lib-stubs already exist from
task-01; all forward wiki-links resolve immediately.

### Back to `concepts/`, `project-shape/`, `messaging/`

Required by task-08 §5 — all targets covered:

- `[[shared-libs-philosophy]]` — referenced by **all four**
  overviews (`related:` block). The cache-stack carryover
  flagged this back-link is now **eight-doubled** (7 auth +
  ~5 cache + 4 observability = 16 references); audit-time
  (task-12), this back-link should anchor a single canonical
  «Adapter-only imports» section in `project-shape/shared-libs-philosophy.md`.
- `[[hexagonal-architecture]]` — referenced by
  `opentelemetry-overview` (1×; «use-case'ы про OTel не
  знают»).
- `[[api-gateway-pattern]]` — referenced by `pino-logging`
  and `trace-log-correlation` (2×; gateway as
  correlation-thread entry-point).
- `[[message-vs-event-patterns]]` — referenced by
  `opentelemetry-overview`, `pino-logging`, `jaeger-backend`
  (3×; both RPC- and event-handlers get spans).
- `[[routing-keys-and-contracts]]` — referenced by
  `opentelemetry-overview`, `pino-logging`, `trace-log-correlation`
  (3×; `correlationId` in `ICorrelationPayload`).
- `[[rabbitmq-as-bus]]` — referenced by `jaeger-backend` (1×;
  the four-service trace through the three queues).

### Back-links from earlier groups now resolved

Three forward-links from earlier groups to
`[[trace-log-correlation]]` (mentioned in `_carryover-07.md`
§«Suggested adjustments» #9) are now resolved:

- `messaging/routing-keys-and-contracts.md` (task-05) →
  `[[trace-log-correlation]]` — anchors at the
  `ICorrelationPayload`-section.
- `caching/cache-stack-overview.md` (task-06) →
  `[[trace-log-correlation]]` — anchors at the
  `cache.delByPrefix`-OTel-span observation.
- `_carryover-07.md` flagged a possible **third** addition
  from `auth/auth-stack-overview.md`, but the auth articles
  do not currently forward-link to observability (per
  `_carryover-07.md` §«Forward links into other groups»);
  this is left as a follow-up for task-12 if guide-wide
  forward-link enforcement is desired.

### Root file's TOC

`docs/architecture-migration-ru/architecture-migration-guide.md`
already lists all four observability overview articles in
its `### observability/` section (verified at L143-L147;
populated by task-01's scaffolding). No edits to the root
file required this session.

## Verification results

- [x] All four slot files filled; no `заглушка` callouts
      remain (verified by
      `grep -l 'заглушка\|Заглушка' docs/architecture-migration-ru/observability/{opentelemetry-overview,pino-logging,trace-log-correlation,jaeger-backend}.md`
      → 0 hits).
- [x] Every code excerpt has a GitHub permalink pinned to
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664`
      (**42 permalinks total**: 9 + 9 + 12 + 12).
- [x] All cited line ranges validated against `wc -l` of
      each file at the recorded SHA. No off-by-one
      corrections required this session.
- [x] Every `[[wiki-link]]` resolves to a file that exists
      under `docs/architecture-migration-ru/` (verified by
      enumerating distinct targets):
      - Within `observability/`: 4 overviews + 8 lib-stubs
        (task-01 scaffold).
      - Cross-group: `[[shared-libs-philosophy]]`,
        `[[hexagonal-architecture]]`, `[[api-gateway-pattern]]`,
        `[[message-vs-event-patterns]]`,
        `[[routing-keys-and-contracts]]`, `[[rabbitmq-as-bus]]`
        — all hit existing stub or filled files.
- [x] No orphans under `docs/architecture-migration-ru/`
      observability subtree — the root file's
      `### observability/` section already links every
      slot from task-01 to all four overviews and 8 stubs.
- [x] Each article above the 600-word floor (smallest:
      `trace-log-correlation.md` at **~2000 слов**;
      largest: `opentelemetry-overview.md` at **~2600 слов**;
      the median article is ~2100 слов).
- [x] Frontmatter valid on each touched file (`status: review`,
      `updated: 2026-05-16`, `related: [...]` populated with
      6–15 wiki-link entries).
- [x] Each article carries the mandatory `> [!abstract] Кратко`
      callout, `## Глоссарий` section, and `> [!faq]- Проверь
      себя` self-check block (5 questions each).
- [x] Every article has a `## Что почитать дальше` section
      with 3–4 external references (optional per task-01
      §12 #7, included here because the four articles cover
      industry-standard topics with well-known canonical docs).
- [x] No `git` mutating commands were run during this
      session.

## Suggested adjustments to upcoming tasks

1. **task-09 should reuse this group's `[[lib-opentelemetry-*]]`-stub
   convention.** All 8 `lib-*` slots exist with frontmatter;
   `opentelemetry-overview.md` forward-links every one of
   them by exact slug. task-09 only needs to fill bodies —
   no slug edits required. The «Что этот пакет НЕ делает»
   section (per auth-task-07 convention) is **highly
   relevant** here: `@opentelemetry/api` vs
   `@opentelemetry/core` vs `@opentelemetry/sdk-node` are
   easy to confuse, and the cleanest way to explain each is
   by enumerating what it doesn't do.

2. **`@opentelemetry/instrumentation-amqplib` deserves the
   richest «what it does» treatment** in task-09. It's the
   single library that makes the four-service trace
   single-tree; if it were removed, we'd get four
   disconnected traces. `jaeger-backend.md` and
   `opentelemetry-overview.md` both gesture at this; the
   `[[lib-opentelemetry-instrumentation-amqplib]]`-статья
   should walk through the inject/extract mechanism with
   concrete AMQP-property reference (looking at
   `properties.headers.traceparent` in a real message).

3. **`opentelemetry-overview.md` uses one mermaid diagram
   (the cross-service trace tree, ASCII-style).** Cache-stack
   overview (`_carryover-06.md`) and auth-stack-overview
   (`_carryover-07.md`) used full mermaid `flowchart TB`.
   Observability is more naturally tree-shaped (parent/child
   spans) than layer-shaped, so the ASCII tree is the
   right choice. If task-12 audit wants to enforce «every
   stack-overview uses the same diagram style», observability
   is a deliberate exception.

4. **The `OTEL_SDK_DISABLED=true` env-var is mentioned in
   `opentelemetry-overview.md` § «`logMethod` hook»** but
   the **why** of test-context disabling isn't fully
   explained — it's there to avoid OTel-SDK boot cost in
   unit-tests that don't need traces. When `quality/test-strategy.md`
   is written (task-11), it should be the place to explain
   the env-flag's role in the test loop; observability
   articles touch on it but don't own it. Cross-link:
   `[[test-strategy]]` will need to back-link to
   `[[opentelemetry-overview]]`.

5. **`pino-logging.md` introduces `AppNameEnum` as if it's
   well-known** — the enum is defined in `libs/contracts/`
   and powers per-service `customProps`. `project-shape/microservices-split.md`
   (task-03) is the natural home to explain it — there's a
   one-line definition in that article's «MicroserviceQueueEnum +
   AppNameEnum» context. observability articles cite it but
   don't own it.

6. **`TraceContextInterceptor` is mentioned twice as a
   placeholder** (once in `trace-log-correlation.md`, once
   by absence in `opentelemetry-overview.md`). If task-09's
   lib-articles add a clarifying word on auto-instrumentation
   covering response-header `traceparent`, the
   `trace-log-correlation.md` section can stay terse. No
   action required from task-09.

7. **The `~62s notification-consumer span` artifact is now
   documented exactly once** (in `jaeger-backend.md`). If
   any future task adds a Jaeger-UI screenshot or guide
   page, it must back-link there rather than re-explain.
   Treating it as an FAQ entry (`> [!faq]-`) at the
   `jaeger-backend.md` level is sufficient — no new ADR is
   needed; this is operational reality, not a decision.

8. **`logger.module.ts` is now cited by THREE separate
   articles** (`pino-logging` for the whole class,
   `trace-log-correlation` for the `logMethod` body,
   `opentelemetry-overview` indirectly via the
   `getActiveSpan` mention). The file is 80 lines and
   carries an unusual amount of weight per LOC. If task-12
   audit wants to add a single «files that bear the most
   conceptual load» index, `logger.module.ts` belongs near
   the top alongside `tracer.ts`, `cache.port.ts`, and
   `auth.module.ts`.

9. **No new ADRs were necessary** during this writing
   session. The four articles document conventions already
   shipped (ADR-001, ADR-007, ADR-014, ADR-015). No
   architectural decisions were taken.

10. **Forward-link to `auth/` and `application-layer/`
    deferred.** The observability articles do not
    forward-reference `application-layer/use-cases-vs-fat-services.md`
    or any auth article. When task-10 writes the
    application-layer group, `use-cases-vs-fat-services.md`
    is the natural place to cite `LoginUseCase`-style
    `UserLoggedIn`-event-emitting use-cases as carriers of
    `correlationId` + `traceId`. Back-link target:
    `[[pino-logging]]` and `[[trace-log-correlation]]`.
