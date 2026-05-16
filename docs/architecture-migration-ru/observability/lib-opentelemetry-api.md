---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, observability, library, otel]
status: review
related:
  - "[[opentelemetry-overview]]"
  - "[[trace-log-correlation]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-sdk-node]]"
  - "[[lib-opentelemetry-core]]"
  - "[[lib-opentelemetry-auto-instrumentations-node]]"
---

# Библиотека: @opentelemetry/api

> [!abstract] Кратко
> `@opentelemetry/api@^1.9.1` — **публичная поверхность**
> OpenTelemetry. Это объекты `trace`, `context`, `propagation`,
> `diag` и типы `Span`/`SpanContext`/`Tracer`. Сами по себе
> они **ничего не делают** — без зарегистрированного SDK
> `trace.getActiveSpan()` возвращает `undefined`,
> `trace.getTracer(...)` отдаёт no-op-tracer. Это «слот для
> SDK» — стабильный API-контракт (единственный пакет OTel с
> мажором `1.x`), к которому app-code обращается, не зная,
> кто стоит за ним. В нашем проекте — два места: `logger.module.ts`
> вызывает `trace.getActiveSpan()` для trace-log-correlation,
> а `tracer.ts` подключает `diag.setLogger(...)` для отладки
> внутренних сообщений SDK.

## Проблема, которую решает

OTel-экосистема большая: SDK для Node, SDK для browser,
десятки instrumentations, exporters в полудюжину форматов.
Если app-код ссылался бы на конкретные классы SDK
(`NodeSDK`, `SimpleSpanProcessor`), любой бамп SDK ломал бы
приложение. Альтернатива — отделить **API-surface** от
**implementation**: app зовёт стабильный API, а кто его
обслуживает (Node-SDK, browser-SDK, noop) — решается на
boot'е.

Это и есть `@opentelemetry/api`. Версия `1.x` стабильна: за
полтора года API не менялась breaking-образом. SDK
(`@opentelemetry/sdk-node`) живёт на `0.x` и регулярно
обновляется — потому что у него внутренности активно
эволюционируют, но *поверхность*, которую видит app, остаётся
константой.

## Применение в проекте

### Где библиотека используется

Прямой импорт встречается в двух файлах:

```typescript
// libs/observability/tracer.ts
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// ...
if (process.env.OTEL_DIAG_LOG_LEVEL === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}
```

> [GitHub: libs/observability/tracer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/tracer.ts#L16-L31)

`diag` — внутренний логгер SDK: когда что-то идёт не так
(exporter не отвечает, instrumentation падает на патче), SDK
шлёт сообщения в `diag`. По умолчанию — silent; включается
переменной `OTEL_DIAG_LOG_LEVEL=debug`. Полезно для дебага
именно стека OTel-а, не приложения.

```typescript
// libs/observability/logger.module.ts
import { trace } from '@opentelemetry/api';

// ...
hooks: {
  logMethod(inputArgs, method, level) {
    // ...
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext?.traceId && spanContext.spanId) {
      // merge { traceId, spanId } into log record
    }
    method.apply(this, inputArgs);
  },
}
```

> [GitHub: libs/observability/logger.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/logger.module.ts#L3-L50)

`trace.getActiveSpan()` — это **тот** API, который читает
`AsyncLocalStorage`-контекст и достаёт активный span. Если SDK
не зарегистрирован (например, в unit-тестах с
`OTEL_SDK_DISABLED=true`), возвращает `undefined`, и наш
hook делает passthrough ([[trace-log-correlation]]).

### Unit-тест: явная регистрация global'ов

```typescript
// libs/observability/spec/logger.module.spec.ts
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

const contextManager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(contextManager);
const tracerProvider = new BasicTracerProvider();
trace.setGlobalTracerProvider(tracerProvider);
const tracer = trace.getTracer('logger-module.spec');
```

> [GitHub: libs/observability/spec/logger.module.spec.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/spec/logger.module.spec.ts#L1-L18)

Спек регистрирует **минимальный** provider руками — без
`@opentelemetry/sdk-node`. Это работает потому, что
`@opentelemetry/api` — лишь регистрационный слой:
`trace.setGlobalTracerProvider(...)` записывает провайдер в
global-singleton, и любой `trace.getTracer(...)` будет
дергать именно его. В prod-runtime тот же слот занимает
`NodeSDK` ([[lib-opentelemetry-sdk-node]]); в unit-тесте —
`BasicTracerProvider` из `@opentelemetry/sdk-trace-base`.

### Что в API ещё есть

В реальном коде проекта мы используем малую часть `api`. Но
для понимания «что в принципе там есть»:

| API | Что делает | Где используем |
|---|---|---|
| `trace.getActiveSpan()` | Достаёт активный span из текущего async-контекста | `logger.module.ts` |
| `trace.getTracer(name, version?)` | Возвращает `Tracer` для создания custom-span'ов | Не используем (auto-instrumentation хватает) |
| `trace.setGlobalTracerProvider(...)` | Регистрирует SDK | `logger.module.spec.ts` (тестовый стенд) |
| `context.active()` | Текущий async-контекст | Не используем напрямую |
| `context.with(ctx, fn)` | Запустить callback в контексте | `logger.module.spec.ts` (создаём активный span для теста) |
| `context.setGlobalContextManager(mgr)` | Регистрирует context manager | `logger.module.spec.ts` |
| `propagation.inject(ctx, carrier)` | Сериализует context в headers | Не используем напрямую — за нас это делает `instrumentation-http`/`instrumentation-amqplib` |
| `propagation.extract(ctx, carrier)` | Парсит headers обратно в context | Не используем — auto-instrumentation |
| `diag.setLogger(logger, level)` | Включает внутреннее логирование SDK | `tracer.ts` (gated by env-var) |

Если завтра потребуется custom-span поверх
auto-instrumentation, входной билет — `trace.getTracer('app')`
+ `tracer.startActiveSpan('name', fn)`. Это покрыто примером
в [[opentelemetry-overview]] §«Что мы НЕ делаем».

## Что этот пакет НЕ делает

- **Не запускает span'ы.** Без зарегистрированного провайдера
  `trace.getTracer('app').startSpan(...)` вернёт no-op-span,
  который попадает в `/dev/null` экспорта. Регистрация
  провайдера — это `[[lib-opentelemetry-sdk-node]]`.
- **Не патчит модули.** Auto-instrumentation — это
  `[[lib-opentelemetry-auto-instrumentations-node]]`.
- **Не сериализует span'ы наружу.** Exporter — это
  `[[lib-opentelemetry-exporter-trace-otlp-http]]`.
- **Не управляет контекстом.** Сам по себе `context.active()`
  без зарегистрированного `ContextManager` отдаёт
  empty-root-context. AsyncLocalStorage-based-менеджер живёт
  в `@opentelemetry/context-async-hooks` (транзитивная
  зависимость через `sdk-node`).
- **Не задаёт схему атрибутов.** Имена `'service.name'` и
  т.п. — в `[[lib-opentelemetry-semantic-conventions]]`.
- **Не строит `Resource`.** Builder `resourceFromAttributes(...)`
  — в `[[lib-opentelemetry-resources]]`.
- **Не задаёт стандарт propagation'а.**
  `W3CTraceContextPropagator` — в `[[lib-opentelemetry-core]]`.
- **Не является peer-dependency других OTel-пакетов.** Все
  OTel-SDK-пакеты декларируют `@opentelemetry/api` как
  `peerDependency` с диапазоном `>= 1.x`. Это значит — **один**
  инстанс API во всём дереве зависимостей; иначе global-state
  (`global.opentelemetry`) расщепился бы и SDK перестал бы
  видеть `setGlobalTracerProvider(...)`.

## Связанные решения

- [[opentelemetry-overview]] — общий обзор OTel-стека.
- [[trace-log-correlation]] — где `trace.getActiveSpan()`
  делает работу.
- [[jaeger-backend]] — конечная точка span'ов.
- [[lib-opentelemetry-sdk-node]] — кто регистрирует
  provider под этим API в prod-runtime.
- [[lib-opentelemetry-core]] — кто реализует propagator и
  context-manager.
- [[lib-opentelemetry-auto-instrumentations-node]] — кто
  использует `trace.getTracer(...)` для каждого
  пропатченного модуля.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@opentelemetry/api` | Публичная поверхность OTel. Версия `1.x`. |
| `trace` | Namespace с фабриками `getTracer` / `getActiveSpan` / `setGlobalTracerProvider`. |
| `context` | Namespace для async-контекста: `active()`, `with()`, `setGlobalContextManager()`. |
| `propagation` | Namespace для пропагации (inject/extract). Не используем напрямую. |
| `diag` | Internal-logger SDK. `setLogger(...)`-API. |
| `DiagConsoleLogger` | Класс из `@opentelemetry/api`: пишет в `console.*`. |
| `DiagLogLevel` | Enum: `NONE` / `ERROR` / `WARN` / `INFO` / `DEBUG` / `VERBOSE` / `ALL`. |
| `Tracer` | Объект, возвращаемый `trace.getTracer(...)`. Создаёт span'ы. |
| `Span` | Один логический операционный отрезок. |
| `SpanContext` | `{ traceId, spanId, traceFlags, isRemote? }`. |
| `TracerProvider` | Интерфейс: фабрика `Tracer`'ов. Реализуется SDK или test-stub'ами. |
| `ContextManager` | Интерфейс: «как async-контекст хранится». Прод-реализация — `AsyncLocalStorageContextManager`. |
| `peerDependency` | NPM-механизм: «жди от родителя одну версию пакета X». |
| No-op-span | Span, который не пишется никуда. Возвращается, когда нет зарегистрированного provider'а. |

> [!faq]- Проверь себя
> 1. Я зову `trace.getTracer('foo')` без подключённого
>    `tracer.ts`. Что я получу — exception, `undefined`, или
>    что-то ещё? Что станет со span'ами?
> 2. В чём разница между `@opentelemetry/api` (v1.x) и
>    `@opentelemetry/sdk-node` (v0.218.x) в плане
>    стабильности? Почему мажоры разнесены так далеко?
> 3. Где в проекте `trace.setGlobalTracerProvider(...)`
>    вызван? Один раз или несколько?
> 4. Зачем `@opentelemetry/api` живёт в `peerDependency` у
>    всех SDK-пакетов? Что сломалось бы, если бы каждый SDK
>    тянул свою копию `api`?
> 5. `diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)` —
>    что вы увидите в stdout после этого вызова?

## Что почитать дальше

- [`@opentelemetry/api` README](https://github.com/open-telemetry/opentelemetry-js/tree/main/api) —
  список всех namespace'ов и стабильность каждого.
- [OpenTelemetry: API vs SDK distinction](https://opentelemetry.io/docs/specs/otel/overview/#api-sdk-and-implementation) —
  official spec про разделение поверхностей.
