---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, observability, library, otel, transitive]
status: final
related:
  - "[[opentelemetry-overview]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-api]]"
  - "[[lib-opentelemetry-sdk-node]]"
  - "[[lib-opentelemetry-resources]]"
  - "[[lib-opentelemetry-instrumentation-amqplib]]"
---

# Библиотека: @opentelemetry/core

> [!abstract] Кратко
> `@opentelemetry/core@^2.7.1` — **самый «невидимый»**
> пакет в нашем OTel-стеке. Он содержит ключевые
> «утилитные» классы, на которые опираются SDK и
> instrumentation'ы: `W3CTraceContextPropagator`,
> `W3CBaggagePropagator`, `BasicTracerProvider`,
> `CompositePropagator`, плюс набор шаренных helper'ов
> (timestamps, hex-encoding, environment-resolution). В
> `package.json` он указан **явно** только потому, что
> Yarn-resolve-strategy предпочитает явные пины
> транзитивным — приложение не импортирует из него
> **ничего** напрямую. Если убрать его из top-level deps,
> ничего не сломается (потому что и `sdk-node`, и
> `instrumentation-amqplib` тянут его транзитивно), но
> версия станет менее предсказуемой.

## Проблема, которую решает

Все OTel-пакеты опираются на общий набор:

- **`W3CTraceContextPropagator`** — реализует inject/extract
  `traceparent`/`tracestate`-заголовков по W3C-стандарту;
- **`W3CBaggagePropagator`** — реализует W3C-baggage (опциональный
  механизм пропагации произвольных KV-данных рядом с trace'ом);
- **`CompositePropagator`** — комбинатор: берёт несколько
  propagator'ов и предлагает их как один (W3C-traceparent +
  W3C-baggage в одной обёртке);
- **`BasicTracerProvider`** — minimal-реализация
  `TracerProvider` для тестов (используем в
  `logger.module.spec.ts`);
- **`hrTime()`** — высокоточный таймштамп для span'ов;
- **`getEnv()` / `getEnvWithoutDefaults()`** — стандартное
  чтение OTel-env-vars.

Если бы каждый OTel-пакет тащил свою копию W3C-propagator'а,
получилась бы лютая фрагментация: SDK propagate'ит в одном
формате, instrumentation — в другом. `@opentelemetry/core` —
**общий слой**, на который ссылаются все.

## Применение в проекте

### Прямой импорт — отсутствует

```bash
$ grep -rn '@opentelemetry/core' apps/ libs/ --include='*.ts'
# (никаких результатов)
```

`@opentelemetry/core` не импортируется ни одним
файлом в `apps/` или `libs/`. Его строки **подгружаются
транзитивно**:

- `@opentelemetry/sdk-node` импортирует
  `BasicTracerProvider` для extension'ов и `W3CTraceContextPropagator`
  для default-propagator'а;
- `@opentelemetry/instrumentation-amqplib` импортирует
  `propagation.inject` / `propagation.extract` через
  `@opentelemetry/api` (которые **внутри** делегируют в
  `core`'s `W3CTraceContextPropagator`);
- `@opentelemetry/exporter-trace-otlp-http` импортирует
  `hrTimeToTimeStamp` и `getEnv` отсюда.

### Где видна работа `core` в runtime

Сами имена в нашем коде не звучат, но эффекты видны:

| Эффект | Откуда | Что в `core` делает работу |
|---|---|---|
| `traceparent` инжектится в AMQP-properties | `instrumentation-amqplib` | `W3CTraceContextPropagator.inject(...)` |
| `traceparent` извлекается на consume | `instrumentation-amqplib` | `W3CTraceContextPropagator.extract(...)` |
| Span-таймштамп точнее `Date.now()` | SDK | `hrTime()` (через `process.hrtime.bigint()`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` парсится | exporter | `getEnv()` helpers |
| Тестовый `BasicTracerProvider` в `logger.module.spec.ts` | spec-stub | прямой импорт из `@opentelemetry/sdk-trace-base` (peer-dep core'а) |

### Зачем явный pin в `package.json`

В `package.json`:

```json
"@opentelemetry/core": "^2.7.1",
```

> [GitHub: package.json](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/package.json#L55)

`@opentelemetry/sdk-node@0.218.0` уже тянет
`@opentelemetry/core@^2.7.x` транзитивно. Зачем явный pin?

Три причины:

1. **Yarn deduplication.** Если две зависимости тянут
   несовместимые мажоры core'а, Yarn разрешит в две копии —
   и тогда global-state (`propagation.setGlobalPropagator(...)`)
   разойдётся между ними. Явный pin «приклеивает» одну
   версию.
2. **Audit-friendly.** При `yarn outdated` core попадает в
   список, его легко увидеть и обновить вручную.
3. **Конвенция.** Все остальные `@opentelemetry/*` пакеты
   нашего стека тоже top-level в `package.json` (даже
   `instrumentation-amqplib`, который тоже транзитивный).
   Однотипный handling.

### Мажор `2.x` — почему

В то время как `@opentelemetry/api` стабилен на `1.x`, а
SDK живёт на `0.x` (часто breaking-major'ы), `core` живёт
на `2.x`. Это «полу-стабильное» состояние: внутренние утилиты
эволюционируют чаще API, но реже SDK. На практике —
2 мажорных бампа за последние ~2 года.

Когда core поднимется до `3.x`, проверять надо:

- `W3CTraceContextPropagator`-shape (если изменится — ломается
  inject/extract);
- `BasicTracerProvider` constructor (если изменится —
  ломаются тесты в `logger.module.spec.ts`).

## Что этот пакет НЕ делает

- **Не определяет публичный API.** Public API — это
  `[[lib-opentelemetry-api]]`. `core` живёт **под** ним.
- **Не запускает SDK.** Запуск — `[[lib-opentelemetry-sdk-node]]`.
- **Не патчит модули.** Patching —
  `[[lib-opentelemetry-auto-instrumentations-node]]` и
  per-инструментация-пакеты.
- **Не сериализует наружу.** Сериализация — exporter'ов
  (`[[lib-opentelemetry-exporter-trace-otlp-http]]`).
- **Не задаёт схему атрибутов.** Атрибуты —
  `[[lib-opentelemetry-semantic-conventions]]`.
- **Не строит `Resource`.** Builder —
  `[[lib-opentelemetry-resources]]`.
- **Не предлагает custom-API наружу для приложения.** Если
  app-код пишет `import { ... } from '@opentelemetry/core'` —
  это **архитектурный smell**. Всё, что нужно app'у, есть в
  `@opentelemetry/api`.
- **Не задаёт W3C-стандарт.** Реализует его. Стандарт — у
  W3C ([trace-context spec](https://www.w3.org/TR/trace-context/)).

## Связанные решения

- [[opentelemetry-overview]] — общий обзор, где `core`
  «не виден», но без него ничего не работает.
- [[jaeger-backend]] — конец потока span'ов, где
  `W3CTraceContextPropagator`'s работа в headers'ах
  материализуется.
- [[lib-opentelemetry-api]] — публичный namespace
  `propagation`, который делегирует в core.
- [[lib-opentelemetry-sdk-node]] — кто регистрирует
  propagator из core'а в качестве default'а.
- [[lib-opentelemetry-resources]] — на core'е базируется
  тоже (используют утилиты).
- [[lib-opentelemetry-instrumentation-amqplib]] — пакет,
  чьи inject/extract проходят через `W3CTraceContextPropagator`
  из core'а.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@opentelemetry/core` | Транзитивный «утилитный» слой OTel. |
| `W3CTraceContextPropagator` | Реализация W3C `traceparent`/`tracestate` inject/extract. |
| `W3CBaggagePropagator` | Реализация W3C-baggage (для произвольных KV-метаданных). |
| `CompositePropagator` | Комбинатор пропагаторов. |
| `BasicTracerProvider` | Минимальная реализация `TracerProvider` для тестов. |
| `hrTime()` | High-resolution timestamp helper. |
| `getEnv()` | Стандартный helper чтения OTel-env-vars. |
| Транзитивная зависимость | Зависимость, подтянутая через другую зависимость, без явного pin'а. |
| Explicit pin | Top-level-объявление в `package.json` ради контроля версии. |
| Yarn dedup | Механизм сворачивания нескольких versions одного пакета в одну. |
| W3C trace-context spec | https://www.w3.org/TR/trace-context/ |

> [!faq]- Проверь себя
> 1. Я удалил `@opentelemetry/core` из `package.json`
>    (top-level). Что произойдёт на `yarn install`?
> 2. App-код пишет `import { hrTime } from '@opentelemetry/core'`.
>    Что не так с этим импортом архитектурно?
> 3. Где **в runtime** видна работа
>    `W3CTraceContextPropagator` — в каком HTTP-header'е и в
>    каком AMQP-поле?
> 4. На каком мажоре сейчас core, на каком api, на каком
>    sdk-node? Почему такая разница?
> 5. В `package.json` указан **^2.7.1**. `yarn install`
>    подтянет `2.7.5`, или `2.8.0` тоже? А `3.0.0`?

## Что почитать дальше

- [W3C Trace Context Spec](https://www.w3.org/TR/trace-context/) —
  спецификация, которую реализует `W3CTraceContextPropagator`.
- [`@opentelemetry/core` README](https://www.npmjs.com/package/@opentelemetry/core) —
  список экспортов.
- [SemVer ranges in Yarn](https://yarnpkg.com/configuration/manifest#dependencies) —
  как `^` интерпретируется (важно для понимания «когда
  yarn проапгрейдит core»).
