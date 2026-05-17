---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, observability, library, otel, sdk]
status: final
related:
  - "[[opentelemetry-overview]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-api]]"
  - "[[lib-opentelemetry-auto-instrumentations-node]]"
  - "[[lib-opentelemetry-exporter-trace-otlp-http]]"
  - "[[lib-opentelemetry-resources]]"
  - "[[lib-opentelemetry-core]]"
---

# Библиотека: @opentelemetry/sdk-node

> [!abstract] Кратко
> `@opentelemetry/sdk-node@^0.218.0` — **boot-driver**
> OTel'а для Node-приложений. Класс `NodeSDK`-агрегатор: в
> одном конструкторе принимает `resource`, `traceExporter`,
> `instrumentations`, и регистрирует **всё** в global-state
> при вызове `sdk.start()`. Это и есть тот единственный
> момент, когда `trace.getTracer(...)` начинает отдавать
> рабочий tracer, а активные span'ы появляются. В проекте —
> один файл, 71 строка: `libs/observability/tracer.ts`. SDK
> запускается **до** `NestFactory.create*()` через
> side-effect-import первой строкой каждого `main.ts`.

## Проблема, которую решает

OTel-SDK состоит из ~десяти движущихся частей:
`TracerProvider` (фабрика tracer'ов), `Resource` (метаданные
сервиса), `SpanProcessor`-цепочка (batching, sampling),
`SpanExporter` (OTLP/HTTP-отправка), `ContextManager`
(`AsyncLocalStorage` под капотом), `Propagator`
(W3C-traceparent), `getNodeAutoInstrumentations()`-bundle
(monkey-patching).

Подключать их вручную — это ~50 строк boilerplate'а. `NodeSDK`
из `@opentelemetry/sdk-node` принимает их в одной структуре,
сам собирает sane default'ы (batch-processor, W3C-propagator,
AsyncLocalStorage-context-manager), и запускает.

## Применение в проекте

### Boot — единственное место

```typescript
// libs/observability/tracer.ts
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

const SDK_DISABLED = process.env.OTEL_SDK_DISABLED === 'true';

if (!SDK_DISABLED) {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'unknown-service';
  const environment = process.env.NODE_ENV ?? 'development';

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
  });

  const traceExporter = new OTLPTraceExporter();

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  const shutdown = (): void => {
    sdk
      .shutdown()
      .catch((err: unknown) => {
        console.error('OpenTelemetry shutdown error', err);
      })
      .finally(() => process.exit(0));
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export {};
```

> [GitHub: libs/observability/tracer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/tracer.ts#L1-L71)

Прочитаем построчно через линзу «что делает `NodeSDK`»:

- **`new NodeSDK({...})`** — конструктор. Принимает
  `resource` ([[lib-opentelemetry-resources]]), exporter
  ([[lib-opentelemetry-exporter-trace-otlp-http]]), bundle
  инструментаций ([[lib-opentelemetry-auto-instrumentations-node]]).
  **Не запускает ничего.**
- **`sdk.start()`** — вот тут реальная работа:
  - регистрирует `TracerProvider` через
    `trace.setGlobalTracerProvider(...)`;
  - регистрирует `ContextManager` (по умолчанию —
    `AsyncLocalStorageContextManager`) через
    `context.setGlobalContextManager(...)`;
  - регистрирует `W3CTraceContextPropagator` (см.
    [[lib-opentelemetry-core]]);
  - вызывает `instrumentation.enable()` на каждой
    инструментации из массива — те, в свою очередь,
    регистрируют hook на `require()`, и при первом подъёме
    модуля (`http`, `mysql2`, …) патчат его.

После `sdk.start()` любой `trace.getActiveSpan()` начинает
работать, любой Nest-handler автоматически окружён span'ом,
любой `mysql2`-query становится child-span'ом.

### Sane defaults: что мы НЕ настраиваем

`NodeSDK` за нас выбирает:

- **`BatchSpanProcessor`** — буферизует span'ы и шлёт
  пачками. Альтернатива — `SimpleSpanProcessor` (один span =
  один HTTP-запрос). В prod-load'е это разница между «10
  HTTP-call'ов в секунду» и «1 каждые 5 секунд».
- **`AlwaysOnSampler`** — sample 100%. Когда нагрузка
  вырастет, можно прокинуть `sampler` в конструктор;
  сегодня в коде нет.
- **`AsyncLocalStorageContextManager`** — единственный
  правильный context-manager для Node v14+. До 14 был
  `AsyncHooks`-based — устаревший.
- **`W3CTraceContextPropagator`** + `W3CBaggagePropagator` —
  стандарт W3C. См. [[lib-opentelemetry-core]] §«propagator».

### Graceful shutdown

```typescript
const shutdown = (): void => {
  sdk
    .shutdown()
    .catch((err) => { console.error('OpenTelemetry shutdown error', err); })
    .finally(() => process.exit(0));
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
```

> [GitHub: libs/observability/tracer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/tracer.ts#L57-L68)

`sdk.shutdown()` гарантирует, что:

- `BatchSpanProcessor` сделает финальный flush (выпустит все
  накопленные span'ы);
- `OTLPTraceExporter` дождётся ответа от коллектора;
- `ContextManager` отрегистрирует hooks.

Без graceful shutdown'а финальные ~512 span'ов (размер batch'а)
не успевают долететь до коллектора. Docker `docker stop` шлёт
SIGTERM с 10-секундным grace period'ом по умолчанию — этого
с запасом хватает на flush.

`process.once('SIGTERM', ...)` — именно `once`, не `on`:
shutdown идемпотентен, два SIGTERM-сигнала подряд — это
double-call, который SDK не любит.

### Где НЕ используется

В app-коде `NodeSDK` импортируется **только** в `tracer.ts`.
В контроллерах, use-case'ах, репозиториях SDK не виден; весь
интерфейс к нему — через `@opentelemetry/api`-namespace'ы
([[lib-opentelemetry-api]]).

Это и есть main-benefit api/SDK-разделения: SDK живёт в
одном файле, а вокруг — стабильный API-контракт. Бамп SDK
(`0.218 → 0.225`) затронет ровно один файл; в app-коде
ничего не сломается.

## Что этот пакет НЕ делает

- **Не определяет публичный API.** API — это
  `[[lib-opentelemetry-api]]`. SDK **регистрируется под**
  тем API.
- **Не патчит модули.** Patching делают instrumentations,
  собранные в `[[lib-opentelemetry-auto-instrumentations-node]]`.
- **Не сериализует span'ы.** Сериализация — exporter'а,
  `[[lib-opentelemetry-exporter-trace-otlp-http]]`.
- **Не предлагает browser-SDK.** Для browser'а — отдельный
  пакет `@opentelemetry/sdk-trace-web`. У нас Node-only.
- **Не включает метрики и логи как сигналы.** `NodeSDK`
  умеет работать и с `metrics`/`logs`-pipeline'ами OTel'а,
  но в нашем `tracer.ts` указан только `traceExporter` —
  metrics-SDK не запускается, log-SDK не запускается. Это
  сознательно: ADR-001 ставит Pino как наш log-stack, не
  OTel-logs.
- **Не задаёт `OTEL_SDK_DISABLED`-флаг как «вырубить SDK».**
  Это наш код проверяет env-var **перед** `new NodeSDK(...)`.
  SDK сам по себе не предлагает «не запускаться по
  переменной». Это микро-расхождение с upstream-SDK'шным
  поведением, но важное: в unit-тестах мы хотим жить совсем
  без SDK, чтобы не платить ресурсами за то, что нам в
  unit'е не нужно.
- **Не запускает span'ы автоматически без instrumentations.**
  `NodeSDK` без `instrumentations: [...]` — пустой SDK:
  custom span'ы через `trace.getTracer('app').startSpan(...)`
  работают, но автоматических span'ов на HTTP/SQL/AMQP не
  будет.
- **Не делает retry на exporter-ошибках.** Это
  ответственность exporter'а или коллектора. Если коллектор
  лежит — span'ы просто теряются.

## Связанные решения

- [[opentelemetry-overview]] — общий контекст, в который
  встаёт `NodeSDK`.
- [[jaeger-backend]] — куда улетают span'ы после
  `sdk.start()`.
- [[lib-opentelemetry-api]] — namespace'ы `trace`/`context`,
  которые `sdk.start()` регистрирует.
- [[lib-opentelemetry-auto-instrumentations-node]] — bundle,
  передаваемый в `instrumentations: [...]`.
- [[lib-opentelemetry-exporter-trace-otlp-http]] —
  `traceExporter`-аргумент.
- [[lib-opentelemetry-resources]] — `resource`-аргумент.
- [[lib-opentelemetry-core]] — propagator и context-manager
  под капотом.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@opentelemetry/sdk-node` | Boot-driver OTel для Node. |
| `NodeSDK` | Класс-агрегатор. Конструктор + `start()` + `shutdown()`. |
| `sdk.start()` | Регистрирует provider, context-manager, propagator; включает все instrumentations. |
| `sdk.shutdown()` | Flush batch-processor'а, ожидание exporter'а, отрегистрация hooks. |
| `BatchSpanProcessor` | Default-processor: буферизует span'ы и шлёт пачками. |
| `SimpleSpanProcessor` | Альтернатива: один span = один экспорт. Используется в тестах. |
| `AlwaysOnSampler` | Default-sampler: 100% sampling. |
| `AsyncLocalStorageContextManager` | Default-context-manager. Live в `@opentelemetry/context-async-hooks`. |
| `W3CTraceContextPropagator` | Default-propagator: W3C `traceparent`-header. |
| Graceful shutdown | Поведение, гарантирующее, что финальные span'ы успеют покинуть процесс. |
| `peerDependency` (api) | `sdk-node` требует `@opentelemetry/api@1.x` от родителя. |

> [!faq]- Проверь себя
> 1. Что произойдёт с приложением, если убрать
>    `sdk.start()` (а конструктор `NodeSDK({...})` оставить)?
> 2. `sdk.shutdown()` вернёт `Promise<void>` — что внутри
>    него ожидается? Что не успеет, если процесс убьёт
>    `SIGKILL`?
> 3. `instrumentations: [getNodeAutoInstrumentations()]` —
>    что произойдёт, если убрать этот ключ из конструктора?
>    Какие span'ы исчезнут? Останется ли `trace.getActiveSpan()`?
> 4. Зачем `process.once`, а не `process.on`, для
>    SIGTERM-handler'а?
> 5. На дворе следующий мажор SDK (`@opentelemetry/sdk-node@^1.0`).
>    Сколько мест в проекте мы будем менять?

## Что почитать дальше

- [`@opentelemetry/sdk-node` README](https://www.npmjs.com/package/@opentelemetry/sdk-node) —
  список default'ов и опций конструктора.
- [OpenTelemetry: Node SDK getting started](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/) —
  каноничный bootstrap, аналогичный нашему `tracer.ts`.
