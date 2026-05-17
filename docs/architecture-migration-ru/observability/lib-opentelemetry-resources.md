---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, observability, library, otel, resource]
status: final
related:
  - "[[opentelemetry-overview]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-sdk-node]]"
  - "[[lib-opentelemetry-api]]"
  - "[[lib-opentelemetry-semantic-conventions]]"
  - "[[lib-opentelemetry-core]]"
---

# Библиотека: @opentelemetry/resources

> [!abstract] Кратко
> `@opentelemetry/resources@^2.7.1` отвечает за **Resource** —
> набор атрибутов-метаданных, прицепленных к **каждому**
> span'у, который эмитит сервис. В нашем `tracer.ts` это
> две вещи: `service.name` (имя сервиса для Jaeger UI) и
> `deployment.environment.name` (`development` / `production`).
> Builder — `resourceFromAttributes(...)`. Под капотом
> `Resource`-объект merge'ится с авто-detect'ами (host,
> process, OS), и получается финальный «паспорт сервиса».
> Имена атрибутов берутся из
> `@opentelemetry/semantic-conventions` ([[lib-opentelemetry-semantic-conventions]])
> — не из строковых литералов.

## Проблема, которую решает

Span сам по себе говорит «что произошло» (handler был
вызван, query был исполнен). Но не говорит «**кто** это
сделал». Если у нас четыре сервиса, каждый эмитит сотни
span'ов в час — без attribute «service.name» невозможно
ответить «покажи span'ы только retail'а» в Jaeger UI.

`Resource` решает это: один объект, прицепленный ко всем
span'ам этого процесса. На стороне Jaeger'а он показывается
как **колонка слева** (service-name), фильтр для search'а,
группировка в обзоре трейсов.

OTel-spec [определяет](https://opentelemetry.io/docs/specs/semconv/resource/)
канонические resource-атрибуты (`service.name`,
`service.version`, `host.name`, `process.pid`, …). Часть
выставляется руками (мы — `service.name` и
`deployment.environment.name`), часть — автоматически
SDK через `resourceDetectors`.

## Применение в проекте

### Использование в `tracer.ts`

```typescript
// libs/observability/tracer.ts
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'unknown-service';
const environment = process.env.NODE_ENV ?? 'development';

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
});

const sdk = new NodeSDK({
  resource,
  // ...
});
```

> [GitHub: libs/observability/tracer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/tracer.ts#L19-L46)

Builder `resourceFromAttributes(...)` принимает plain-объект
KV и возвращает `Resource`-инстанс. Дальше — передаётся в
`NodeSDK`-конструктор как поле `resource`.

`OTEL_SERVICE_NAME` — env-var, обязательная по Joi-схеме
([[opentelemetry-overview]] §«Env-конфигурация»). Fallback
`'unknown-service'` остаётся «защитой от случая, когда
Joi-валидация почему-то не отработала» — в proper boot'е он
не используется, потому что приложение не стартует без
env-var'а.

`NODE_ENV` приходит из `docker-compose.yml`
(`NODE_ENV: development`); fallback `'development'` — для
случая, когда `tracer.ts` ранится в локальной shell'е без
env-var'а. Это и есть значение для
`deployment.environment.name`.

### Что в `resourceSpans` JSON-payload'е

В OTLP-payload'е (см. [[lib-opentelemetry-exporter-trace-otlp-http]]
§«Что в HTTP-запросе») resource выглядит как:

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "api-gateway" } },
          { "key": "deployment.environment.name", "value": { "stringValue": "development" } }
        ]
      },
      "scopeSpans": [ /* span'ы */ ]
    }
  ]
}
```

Это **один** объект на весь batch span'ов — не повторяется
per-span. Это важная экономия в wire-payload'е: иначе
каждый span тащил бы `service.name` за собой, и payload
вырос бы в полтора раза.

### Auto-detect: что приходит само

`NodeSDK` под капотом конкатенирует наш `resource` с
**auto-detected resource'ом**. По умолчанию detect'ятся
(если env-vars подсказывают):

- `host.name`, `host.id`;
- `process.pid`, `process.executable.name`,
  `process.runtime.name: 'nodejs'`;
- `os.type`, `os.version`;
- `container.id` (если запущен в docker).

Мы это не настраиваем; SDK делает за нас. В Jaeger UI'е
правая панель span'а покажет эти атрибуты «бесплатно».

### Почему `resourceFromAttributes`, а не `new Resource({...})`

В версиях OTel-resources до `2.x` builder назывался
`new Resource({...})`. В `2.x` он переименован в
`resourceFromAttributes(...)`-функцию ради
TypeScript-strictness'а и одинаковости с другими OTel-builder'ами
(`resourceFromAttributes`, `tracerProviderFromConfig`,
`exporterFromConfig`).

Семантически — то же самое: создаёт `Resource`-объект из
attribute-map'а. Просто синтаксис изменился.

### Что **мог бы** быть в resource'е

`@opentelemetry/semantic-conventions` ([[lib-opentelemetry-semantic-conventions]])
предлагает десятки канонических ключей:

| Канонический ключ | Что значит | У нас? |
|---|---|---|
| `service.name` | Имя сервиса | ✓ |
| `service.version` | Семвер-тег приложения | ✗ (TODO: подцепить `package.json#version`) |
| `service.namespace` | Логическая группа | ✗ |
| `service.instance.id` | UUID одного запуска | ✗ (SDK auto-генерит, если не задано) |
| `deployment.environment.name` | dev/staging/prod | ✓ |
| `host.name` | Hostname машины | ✓ (auto) |
| `process.runtime.name` | `'nodejs'` | ✓ (auto) |
| `container.id` | docker-container-id | ✓ (auto, если в контейнере) |
| `k8s.pod.name` | Kubernetes-pod | ✗ (нет в локал-дев'е) |
| `cloud.provider` | `aws`/`gcp`/`azure` | ✗ |

Если завтра приложение задеплоится в Kubernetes, OTel
имеет K8s-resource-detector'ы (отдельный пакет
`@opentelemetry/resource-detector-kubernetes`), которые
автоматически подхватят `k8s.*`-атрибуты. Это **не наша
работа** — в коде ничего не меняется, только зависимость
добавляется.

## Что этот пакет НЕ делает

- **Не задаёт имена атрибутов.** Имена (`'service.name'`)
  — в `[[lib-opentelemetry-semantic-conventions]]`.
  `resources` — это **builder** и контейнер; он принимает
  имена и значения, но сам их не выбирает.
- **Не задаёт значения атрибутов.** `service.name = 'api-gateway'`
  — это решение, принятое в `tracer.ts` (из
  `OTEL_SERVICE_NAME` env-var'а).
- **Не auto-detect'ит само.** Auto-detection — задача
  `NodeSDK` ([[lib-opentelemetry-sdk-node]]), которое
  использует `resourceDetectors`. Сам `@opentelemetry/resources`
  предлагает класс `Resource` и builder; detection-функции
  поставляются отдельным пакетом.
- **Не выводит resource в логи.** Логи — Pino-стека.
- **Не пропагирует resource cross-service.** Resource живёт
  per-service — каждый сервис имеет свой `service.name`.
  Trace-context (что общее) пропагируется через
  `traceparent`-header.
- **Не привязан к Jaeger.** Resource-атрибуты — это
  vendor-neutral concept. Honeycomb, Tempo, Datadog читают
  их одинаково.

## Связанные решения

- [[opentelemetry-overview]] — общая роль Resource в
  OTel-данных.
- [[jaeger-backend]] — где `service.name` материализуется в
  левой колонке UI.
- [[lib-opentelemetry-sdk-node]] — куда передаётся
  `resource`-аргумент.
- [[lib-opentelemetry-api]] — `trace`-namespace, не
  знающий про resource'ы (они на уровне SDK).
- [[lib-opentelemetry-semantic-conventions]] — откуда
  берутся имена `service.name` и т.д.
- [[lib-opentelemetry-core]] — транзитивные утилиты, на
  которые `resources` опирается.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@opentelemetry/resources` | Builder и контейнер для Resource-атрибутов. |
| Resource | Набор атрибутов-метаданных, прицепленных ко всем span'ам процесса. |
| `resourceFromAttributes(...)` | Builder-функция; принимает KV, возвращает `Resource`. |
| `Resource` (класс) | Контейнер атрибутов. |
| `service.name` | Канонический атрибут: имя сервиса. У нас обязательный. |
| `deployment.environment.name` | Канонический атрибут: окружение деплоя. У нас `dev`/`prod`. |
| `service.version` | Канонический атрибут: версия сервиса. Не задаём; TODO. |
| `service.instance.id` | Канонический атрибут: UUID одного запуска. SDK auto-генерит. |
| Resource detectors | Пакеты, авто-детектирующие атрибуты из окружения (host, container, K8s, cloud). |
| `resourceSpans` (OTLP-payload) | Внешняя обёртка JSON-payload'а: resource + span'ы. |
| Resource attribute merge | Поведение SDK: user-defined resource + auto-detected = final resource. |
| Per-service Resource | Resource не пропагируется между сервисами; каждый имеет свой. |

> [!faq]- Проверь себя
> 1. Если убрать `resourceFromAttributes({...})` и
>    передать `resource: undefined` в `NodeSDK`, какие
>    атрибуты останутся в `resourceSpans` JSON-payload'а?
> 2. Один и тот же `traceId` пришёл с двух разных
>    `service.name`. Что это значит про call-graph?
> 3. Чтобы добавить `service.version: '1.2.3'`, какое
>    действие проще: руками в `tracer.ts` или через
>    env-var `OTEL_RESOURCE_ATTRIBUTES=service.version=1.2.3`?
>    Какие отличия?
> 4. Каноническое имя `service.name` — почему мы импортируем
>    `ATTR_SERVICE_NAME`-константу, а не пишем `'service.name'`
>    литералом?
> 5. На каком уровне resource «прицепляется» к span'у —
>    SDK, exporter, или коллектор?

## Что почитать дальше

- [OpenTelemetry Resource semantic conventions](https://opentelemetry.io/docs/specs/semconv/resource/) —
  полный канонический список атрибутов.
- [`@opentelemetry/resources` README](https://www.npmjs.com/package/@opentelemetry/resources) —
  builder API.
- [Resource Detectors](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/detectors) —
  список auto-detector'ов (K8s, AWS, GCP, Container).
