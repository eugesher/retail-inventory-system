---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, observability, library, otel, constants]
status: final
related:
  - "[[opentelemetry-overview]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-resources]]"
  - "[[lib-opentelemetry-api]]"
  - "[[lib-opentelemetry-sdk-node]]"
  - "[[lib-opentelemetry-core]]"
---

# Библиотека: @opentelemetry/semantic-conventions

> [!abstract] Кратко
> `@opentelemetry/semantic-conventions@^1.41.1` — это
> **просто словарь констант**. Никакого runtime'а — только
> exported-строки вида `ATTR_SERVICE_NAME = 'service.name'`,
> `ATTR_HTTP_METHOD = 'http.method'`, `ATTR_DB_SYSTEM = 'db.system'`.
> Их назначение — не давать вам писать `'service.name'`
> как магическую строку, а использовать константу, имя
> которой TypeScript-IDE подсказывает. В проекте импорт —
> в одном файле, `libs/observability/tracer.ts`: две
> константы (`ATTR_SERVICE_NAME`,
> `ATTR_DEPLOYMENT_ENVIRONMENT_NAME`). Этот единственный
> OTel-пакет в нашем стеке с **стабильным мажором `1.x`**
> — потому что строки-имена меняться не должны (иначе
> ломается интероп с любым vendor'ом).

## Проблема, которую решает

Если бы каждый OTel-инструментированный код писал имена
атрибутов руками:

```typescript
// БАД
resource.add('servic.name', 'api-gateway');  // typo, span_attribute не зарегистрируется
span.setAttribute('http.method', 'POST');     // правильно
span.setAttribute('httpMethod', 'POST');      // другая ошибка — не каноническое имя
```

— получили бы typo-bugs (Jaeger UI не группирует по
неправильному ключу, фильтр не находит) и фрагментацию имён
(`httpMethod` vs `http.method` vs `http_method`). Это
**универсальная** проблема: одинаковость имён нужна
**между** инструментацией нашей и vendor'а, и между нашими
сервисами, и между нашим кодом и third-party-кодом.

OTel-spec [Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
определяет канонические имена и значения для:

- **Resource-атрибутов**: `service.*`, `deployment.*`,
  `host.*`, `process.*`, `k8s.*`, `cloud.*`.
- **Span-атрибутов**: `http.*`, `db.*`, `rpc.*`,
  `messaging.*`, `network.*`.
- **Event-имён**: `exception` и т.д.

`@opentelemetry/semantic-conventions` экспортирует эти
имена как TypeScript-константы. Импорт константы вместо
литерала даёт три выгоды: typo-resistance, IDE-autocomplete,
явная зависимость в коде на конкретную версию spec'а.

## Применение в проекте

### Где импортируется

```typescript
// libs/observability/tracer.ts
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
});
```

> [GitHub: libs/observability/tracer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/tracer.ts#L21-L39)

`ATTR_SERVICE_NAME` — это просто `'service.name'`-строка.
`ATTR_DEPLOYMENT_ENVIRONMENT_NAME` — `'deployment.environment.name'`.

Computed-property-syntax `[ATTR_SERVICE_NAME]: serviceName`
строит JS-объект `{ 'service.name': 'api-gateway',
'deployment.environment.name': 'development' }`. Это и есть
attribute-map, который `resourceFromAttributes(...)`
([[lib-opentelemetry-resources]]) превращает в `Resource`.

### Что в пакете есть ещё

Помимо двух констант, которые мы используем, есть сотни
других:

| Группа | Пример константы | Значение |
|---|---|---|
| Service | `ATTR_SERVICE_NAME`, `ATTR_SERVICE_VERSION`, `ATTR_SERVICE_NAMESPACE` | `'service.name'`, `'service.version'`, `'service.namespace'` |
| Deployment | `ATTR_DEPLOYMENT_ENVIRONMENT_NAME` | `'deployment.environment.name'` |
| HTTP | `ATTR_HTTP_REQUEST_METHOD`, `ATTR_HTTP_RESPONSE_STATUS_CODE`, `ATTR_URL_PATH` | `'http.request.method'`, `'http.response.status_code'`, `'url.path'` |
| DB | `ATTR_DB_SYSTEM`, `ATTR_DB_STATEMENT`, `ATTR_DB_OPERATION` | `'db.system'`, `'db.statement'`, `'db.operation'` |
| Messaging | `ATTR_MESSAGING_SYSTEM`, `ATTR_MESSAGING_DESTINATION_NAME` | `'messaging.system'`, `'messaging.destination.name'` |
| Process | `ATTR_PROCESS_PID`, `ATTR_PROCESS_RUNTIME_NAME` | `'process.pid'`, `'process.runtime.name'` |
| Exception | `ATTR_EXCEPTION_TYPE`, `ATTR_EXCEPTION_MESSAGE` | `'exception.type'`, `'exception.message'` |

В нашем коде мы импортируем **только** две (service.name,
deployment.environment.name). Остальные пишутся
auto-instrumentation'ом ([[lib-opentelemetry-auto-instrumentations-node]])
— они импортируют свои группы констант сами.

### `ATTR_*` vs `SemanticResourceAttributes.*`

В старых релизах пакета имена жили в namespace'е:
`SemanticResourceAttributes.SERVICE_NAME`. В `1.41.x` они
перенесены в плоские именованные экспорты:
`ATTR_SERVICE_NAME`. Старый namespace оставлен как deprecated
re-export для backward-compat.

Это переход на «one constant per import» — лучше для
tree-shaking'а в bundler'ах и для TypeScript-strictness'а.

### Версия `1.41.1` — почему стабильная

`@opentelemetry/semantic-conventions` — **единственный**
OTel-пакет в нашем `package.json`, который живёт на мажоре
`1.x` (`api` тоже на `1.x`, но это совпадение, не значимое
— `api` — это namespace surface, а `semantic-conventions` —
строковый словарь).

Мажорная стабильность — by design: если бы строки имён
меняли мажорно (`'service.name'` → `'service.id'`), это
сломало бы:

- vendor-backends'ы, которые ждут конкретные имена;
- queries operators'ов («фильтр по `service.name`»);
- кросс-team-документацию.

Поэтому upstream добавляет новые константы (нон-breaking),
но **не переименовывает** старые. У нас на момент SHA —
`1.41.1`. Когда выйдет `1.50` — yarn подтянет автоматически
(`^1.41.1`); ничего у нас не сломается.

### Что **не** есть в пакете

В пакете — **только** строки-константы. Нет:

- Валидации значений (значение `db.system` должно быть в
  enum'е `'mysql'`/`'postgresql'`/..., но пакет не проверяет —
  он просто говорит, как называется ключ);
- Runtime-логики (это plain-strings-словарь);
- Группировки атрибутов в подмножества (если хочется
  HTTP-related, импортируешь руками каждую `ATTR_HTTP_*`).

### Когда мы могли бы хотеть импортировать больше

Если завтра в use-case появится custom `tracer.startActiveSpan('order.confirm', ...)`
и захочется проставить domain-атрибуты — конвенция была бы:

```typescript
// гипотетика
span.setAttribute(ATTR_MESSAGING_DESTINATION_NAME, 'retail.order.confirm');
span.setAttribute('app.order_id', orderId);  // custom — без константы, не из spec'а
```

OTel-canonical-имена импортируются как константы; custom-имена
(`'app.order_id'`) пишутся литералом — потому что для них в
spec'е нет канона. По конвенции custom-имена начинаются с
`'app.'` (namespace вашего приложения).

## Что этот пакет НЕ делает

- **Не валидирует значения.** `setAttribute(ATTR_DB_SYSTEM, 'не-mysql')`
  — пакет пропустит, даже если значение нет в OTel-enum'е.
- **Не задаёт runtime-поведение.** Пакет — только строки.
- **Не auto-emit'ит** атрибуты на span'ы. Атрибуты ставятся
  кодом инструментации или приложением — пакет лишь даёт
  «правильное имя».
- **Не является peer-dep'ом** других OTel-пакетов. Они тоже
  импортируют свои константы из него.
- **Не покрывает custom-domain-атрибуты.** Для `order.id`,
  `user.tier`-типа — пишутся литералами.
- **Не зависит от SDK.** Plain-string-словарь; runtime
  отсутствует.
- **Не определяет canonical-значения** для enum'ных атрибутов
  (типа `db.system: 'mysql' | 'postgresql' | ...`).
  Значения тоже определены в OTel-spec'е, но в этом пакете
  не экспортируются как enum-объект (есть отдельный группы
  констант, но мы их не используем).

## Связанные решения

- [[opentelemetry-overview]] — где аттрибуты span'ов
  материализуются (через auto-instrumentation).
- [[jaeger-backend]] — где аттрибуты видны: правая панель
  UI, фильтр по `service.name`.
- [[lib-opentelemetry-resources]] — куда `ATTR_SERVICE_NAME`
  передаётся.
- [[lib-opentelemetry-api]] — `span.setAttribute(...)`-API,
  принимающий эти ключи.
- [[lib-opentelemetry-sdk-node]] — SDK, который обрабатывает
  атрибуты.
- [[lib-opentelemetry-core]] — независимая утилитная
  библиотека; не пересекается напрямую.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@opentelemetry/semantic-conventions` | Plain-string-словарь канонических имён OTel-атрибутов. |
| Semantic conventions | OTel-spec, определяющий правильные имена атрибутов. |
| `ATTR_SERVICE_NAME` | Константа `'service.name'`. |
| `ATTR_DEPLOYMENT_ENVIRONMENT_NAME` | Константа `'deployment.environment.name'`. |
| `ATTR_HTTP_REQUEST_METHOD` | Константа `'http.request.method'`. |
| `ATTR_DB_SYSTEM` | Константа `'db.system'`. Значения: `'mysql'`, `'postgresql'`, … (не enum'ом). |
| `ATTR_MESSAGING_SYSTEM` | Константа `'messaging.system'`. У нас будет `'rabbitmq'`. |
| Resource-атрибут | Атрибут, прицепленный к Resource (живёт per-service). |
| Span-атрибут | Атрибут, прицепленный к одному span'у. |
| Canonical name | Имя, определённое OTel-spec'ом. |
| Custom attribute | Domain-имя, не из spec'а. Префикс `'app.'`-неймспейс by convention. |
| Computed property | JS-syntax `{ [KEY]: value }`. |
| Tree-shaking | Bundler-оптимизация: убирает неиспользуемые экспорты. Лучше работает с плоскими экспортами, чем с namespace'ами. |
| `SemanticResourceAttributes` (deprecated) | Старый namespace-style; deprecated alias на новые `ATTR_*`. |

> [!faq]- Проверь себя
> 1. Я написал `resource.attributes['servic.name'] = 'foo'`
>    (опечатка). Что попадёт в `resourceSpans`-payload?
>    Что увидит Jaeger UI?
> 2. Какой мажор `semantic-conventions` сейчас и почему он
>    отличается от мажора `sdk-node`?
> 3. Я хочу добавить custom-аттрибут `order.id`. Какие
>    префиксы по конвенции — для OTel-canonical и для
>    custom?
> 4. `ATTR_SERVICE_NAME` — это строка или объект-helper? Что
>    написано в runtime'е (после транспиляции)?
> 5. Если мы импортируем `ATTR_HTTP_METHOD`, но в коде её
>    не используем, попадёт ли строка `'http.method'` в
>    финальный bundle webpack'а?

## Что почитать дальше

- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/) —
  спецификация всех канонических имён.
- [`@opentelemetry/semantic-conventions` README](https://www.npmjs.com/package/@opentelemetry/semantic-conventions) —
  список групп констант.
- [SemConv stability levels](https://opentelemetry.io/docs/specs/otel/document-status/) —
  какие группы атрибутов стабильны, какие experimental
  (последнее — может ломаться мажорно).
