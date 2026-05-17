---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, observability, otel, overview]
status: final
related:
  - "[[pino-logging]]"
  - "[[trace-log-correlation]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-api]]"
  - "[[lib-opentelemetry-sdk-node]]"
  - "[[lib-opentelemetry-auto-instrumentations-node]]"
  - "[[lib-opentelemetry-instrumentation-amqplib]]"
  - "[[lib-opentelemetry-exporter-trace-otlp-http]]"
  - "[[lib-opentelemetry-core]]"
  - "[[lib-opentelemetry-resources]]"
  - "[[lib-opentelemetry-semantic-conventions]]"
  - "[[shared-libs-philosophy]]"
  - "[[message-vs-event-patterns]]"
  - "[[routing-keys-and-contracts]]"
  - "[[hexagonal-architecture]]"
---

# Обзор OpenTelemetry

> [!abstract] Кратко
> OpenTelemetry — vendor-neutral стандарт распределённого
> трейсинга: каждый сервис эмитит **span**'ы (один логический
> вызов), они склеиваются в **trace** (целое путешествие
> запроса) через W3C `traceparent`-заголовок. В проекте
> OTel-SDK живёт в `libs/observability/tracer.ts` и
> подключается **side-effect-импортом** **первой строкой**
> каждого `main.ts` — иначе auto-instrumentation не успеет
> пропатчить `http`/`mysql2`/`redis`/`amqplib` до того, как
> Nest их подгрузит. Один OTLP/HTTP-экспорт → один
> otel-collector → один Jaeger; смена бэкенда — это смена
> конфига коллектора, а не кода приложения. Восемь
> `@opentelemetry/*`-пакетов разнесены по
> `[[lib-opentelemetry-*]]`-статьям рядом.

## Проблема, которую решает

После того как [ADR-001](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/001-structured-logging-with-pino.md)
дал нам Pino-логи с `correlationId`, ответ на вопрос
«какие строки лога относятся к одному запросу» стал тривиальным
(`jq 'select(.correlationId == "abc")'`). Но остался класс
вопросов, на которые `correlationId` не отвечает:

- **Где ушла латентность?** `PUT /api/order/:id/confirm`
  занял 800ms — где они: gateway→retail, retail→inventory,
  TypeORM-запрос, Redis-promise, AMQP publish/process?
- **Где упал запрос?** Notification получил пустой payload —
  это retail отправил пустое, или inventory не отдал, или
  amqplib потерял по пути?
- **Какой parent у этого span'а?** В call-graph'е
  `gateway → retail → inventory → notification` три
  кросс-сервисных хопа через RabbitMQ — нужен механизм,
  по которому consumer узнаёт ID родительского span'а
  producer'а.

Эти вопросы — про **call-graph**, не про **request scope**.
Их решает распределённый трейсинг. Pino-логи и OTel-span'ы
покрывают разные плоскости и **сосуществуют** на одной строке
лога ([[trace-log-correlation]]) — это явное решение, не
overlap.

OpenTelemetry — индустриальный стандарт CNCF: API + SDK +
протокол + auto-instrumentation. [ADR-007](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/007-pino-and-opentelemetry.md)
зафиксировал OTel-shape ещё до фактического wiring'а;
[ADR-014](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/014-otel-exporter-otlp-http-and-jaeger.md)
довёл его до боевого состояния с Jaeger'ом.

## Концепция

### Базовые сущности

OTel оперирует тремя сущностями, и понимание их — это половина
понимания всего стека.

**Span** — одна логическая операция: HTTP-handler, SQL-запрос,
publish в очередь, custom-блок-кода. У span'а есть:

- `traceId` (128 бит) — общий для всех span'ов одного запроса;
- `spanId` (64 бита) — уникальный для этого span'а;
- `parentSpanId` — указатель «выше по call-graph'у»;
- временные границы (`startTime`, `endTime`);
- **attributes** (key-value: `http.method=GET`, `db.statement=SELECT...`);
- **events** (точки во времени с сообщением);
- **status** (`OK` / `ERROR` / `UNSET`).

**Trace** — дерево span'ов с общим `traceId`. Root-span —
тот, у которого нет `parentSpanId`. У нас root рождается на
gateway, когда auto-instrumentation перехватывает
HTTP-request:

```
trace (id: 1a2b3c…)
└─ POST /api/order               ← root, gateway
   ├─ retail.order.create        ← AMQP publish, gateway
   │  └─ retail.order.create     ← AMQP process, retail
   │     └─ INSERT INTO orders   ← TypeORM, retail
   └─ ...
```

**Context** — невидимое нечто, привязанное к async-цепочке
вызовов (через `AsyncLocalStorage` в Node.js). В нём живёт
**активный span**. `trace.getActiveSpan()` — функция API,
которая «достаёт текущий span из контекста». Именно её зовёт
наш Pino-hook ([[trace-log-correlation]]).

### Propagation: как trace переходит границы

Внутри одного процесса span'ы склеиваются автоматически через
`AsyncLocalStorage`. Между процессами — нужно явное распространение
(propagation), и OTel выбирает W3C-стандартный формат: HTTP-header
`traceparent`:

```
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01
             │  │                                │                │
             │  │                                │                └─ trace-flags (01 = sampled)
             │  │                                └─ parent-span-id
             │  └─ trace-id (16 байт)
             └─ version
```

На HTTP-выходе producer кладёт `traceparent` в header. На входе
consumer достаёт его, восстанавливает context, и его собственный
span получит `parentSpanId` равный `parent-span-id` producer'а.
**Что критично у нас**: `traceparent` распространяется не только
по HTTP. `@opentelemetry/instrumentation-amqplib` ([[lib-opentelemetry-instrumentation-amqplib]])
**инжектит** `traceparent` в `properties.headers` AMQP-сообщения
на `publish`, и **извлекает** его на `consume`. Это и есть
механизм, по которому trace `gateway → retail → inventory →
notification` остаётся **одним** деревом, хотя три из четырёх
хопов проходят через RabbitMQ.

### Resource attributes

`Resource` — это «паспорт сервиса», прицепленный ко **всем**
span'ам, которые он эмитит. У нас два атрибута, заданные в
`tracer.ts`:

- `service.name` — название сервиса (`api-gateway`,
  `retail-microservice` и т.д.). Это то, по чему Jaeger UI
  группирует span'ы в левой колонке.
- `deployment.environment.name` — `development` / `production`.

Имена константами берутся из
`@opentelemetry/semantic-conventions` ([[lib-opentelemetry-semantic-conventions]])
— чтобы не писать строки `'service.name'` руками и не разойтись
с экосистемой.

### Exporter и collector

**Exporter** — компонент SDK, который сериализует span'ы и
отправляет их «куда-то». Форматов несколько (Jaeger-thrift,
Zipkin-JSON, OTLP), [ADR-014](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/014-otel-exporter-otlp-http-and-jaeger.md)
выбирает **OTLP/HTTP** (`@opentelemetry/exporter-trace-otlp-http`,
см. [[lib-opentelemetry-exporter-trace-otlp-http]]). Причины:

- одна зависимость, никаких native-сборок (vs gRPC);
- легко дебажить (`curl -X POST` против коллектора);
- легко свапнуть бэкенд — об этом ниже.

**Collector** — отдельный процесс (контейнер `otel/opentelemetry-collector-contrib`),
который **принимает** OTLP от приложений, **процессит** (batch,
sample, drop) и **переотправляет** дальше. Локально мы держим
коллектор перед Jaeger'ом, хотя Jaeger принимает OTLP напрямую
— чтобы топология локальная **совпадала** с продовой
([[jaeger-backend]] подробно). Замена Jaeger → Honeycomb (или
любого vendor'а) — это смена `exporters:` в YAML-конфиге
коллектора. **App-код не меняется**.

### Auto-instrumentation: что патчится и когда

Самое мощное в OTel-Node — `@opentelemetry/auto-instrumentations-node`
([[lib-opentelemetry-auto-instrumentations-node]]). Это
bundle отдельных инструментаций, который **monkey-patch'ит**
популярные модули в момент их `require()`:

- `@opentelemetry/instrumentation-http` — каждый HTTP-server-handler
  и каждый outgoing-`fetch`/`axios` становится span'ом;
- `@opentelemetry/instrumentation-mysql2` — каждый SQL-запрос
  TypeORM (TypeORM сам не патчится — он зовёт `mysql2`);
- `@opentelemetry/instrumentation-redis` — каждый Redis-command;
- `@opentelemetry/instrumentation-amqplib` — publish/consume и
  inject/extract `traceparent`;
- `@opentelemetry/instrumentation-nestjs-core` — handler'ы Nest,
  guards, interceptors.

Каждая инструментация работает так: импортируется как побочный
эффект, регистрирует hook на `require('http')` (через
`require-in-the-middle`), и при первом подъёме модуля **подменяет**
его экспорты на пропатченные. Это и есть **runtime-patching** —
никакой кодогенерации.

### Side-effect import: правило **первой строки**

И вот тут — самое важное операционное правило проекта. Поскольку
auto-instrumentation работает через перехват `require()`, **она
должна успеть зарегистрировать hooks ДО того, как любой
приложенческий код подгрузит `http`/`mysql2`/`redis`/`amqplib`**.
Если Nest успеет вызвать `NestFactory.create()` первым, он
подгрузит `http` под капотом, и патч уже **не сработает** — span'ы
для HTTP-handler'ов просто не будут эмитироваться, при этом
SDK не выкинет ошибку. Это самый коварный класс багов:
SDK работает, экспортит, в Jaeger что-то приходит — но не то,
что ожидаешь.

Решение — **side-effect-импорт**:

```typescript
// apps/api-gateway/src/main.ts
import '@retail-inventory-system/observability/tracer';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
// ...
```

> [GitHub: apps/api-gateway/src/main.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/main.ts#L1-L12)

**Первая строка** каждого `main.ts` (всех четырёх сервисов!) —
этот импорт. Файл `libs/observability/tracer.ts` запускается
до того, как Nest начнёт загружаться, успевает зарегистрировать
patches, и только потом «оживает» бизнес-код.

Если эту строку случайно опустить или auto-formatter переставит
импорты в алфавитном порядке (как любят делать ESLint-rules) —
**span'ы тихо исчезнут**. ESLint-правила, которое бы это ловило,
сегодня нет (см. ADR-007 «Consequences»). Контракт держится на
ревью + явный комментарий в `tracer.ts`.

### Boot inside `tracer.ts`

Сам `tracer.ts` короткий — 71 строка. Что в нём происходит:

```typescript
// libs/observability/tracer.ts
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
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
  // ...
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
  // graceful shutdown handlers...
}

export {};
```

> [GitHub: libs/observability/tracer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/tracer.ts#L16-L71)

Каждая строка тянет одну `@opentelemetry/*`-зависимость, и каждая
из них имеет dedicated lib-статью:

- `@opentelemetry/api` — публичный API (`trace`, `context`,
  `diag`). См. [[lib-opentelemetry-api]].
- `@opentelemetry/sdk-node` — `NodeSDK`-агрегатор: собирает
  exporter + instrumentations + resource в один объект и
  запускает. См. [[lib-opentelemetry-sdk-node]].
- `@opentelemetry/auto-instrumentations-node` — bundle всех
  «коробочных» инструментаций. См. [[lib-opentelemetry-auto-instrumentations-node]].
- `@opentelemetry/exporter-trace-otlp-http` — OTLP-over-HTTP
  exporter. См. [[lib-opentelemetry-exporter-trace-otlp-http]].
- `@opentelemetry/resources` — `resourceFromAttributes(...)`
  builder. См. [[lib-opentelemetry-resources]].
- `@opentelemetry/semantic-conventions` — константы
  `ATTR_SERVICE_NAME` и т.д. См. [[lib-opentelemetry-semantic-conventions]].
- `@opentelemetry/instrumentation-amqplib` — отдельная
  инструментация amqplib (входит в bundle, но достойна
  отдельной статьи: это **она** делает четыре сервиса одним
  trace'ом). См. [[lib-opentelemetry-instrumentation-amqplib]].
- `@opentelemetry/core` — context manager, propagator;
  почти всегда транзитивный. См. [[lib-opentelemetry-core]].

### Что мы НЕ делаем

Принципиально — мы **не пишем custom span'ы в use-case'ах**.
Auto-instrumentation уже даёт span на каждый Nest-controller,
каждый Nest-`@MessagePattern`-handler (см.
[[message-vs-event-patterns]]), каждый TypeORM-запрос, каждую
Redis-команду, каждый `publish`/`process` AMQP. Дерево уже
правильной формы. Если когда-нибудь понадобится обернуть
кусок не-инструментируемой логики (например, custom CPU-bound
блок) — `trace.getTracer('app').startActiveSpan(...)` остаётся
доступным, но это **исключение**. Из этого правила есть один
оправданный pre-existing exception: `RedisCacheAdapter.delByPrefix`
сам открывает span `cache.delByPrefix`, потому что эта функция —
не одна Redis-команда, а domain-уровневый цикл SCAN+UNLINK
([[trace-log-correlation]] и `cache-stack-overview` подробно).

## Применение в проекте

### Где импорт стоит первой строкой

Во всех четырёх `main.ts`:

```typescript
// apps/notification-microservice/src/main.ts
import '@retail-inventory-system/observability/tracer';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
// ...
```

> [GitHub: apps/notification-microservice/src/main.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/main.ts#L1-L10)

Аналогично — в `retail-microservice/src/main.ts`,
`inventory-microservice/src/main.ts`, `api-gateway/src/main.ts`.
Контракт **жёсткий**: одно отклонение в одном файле — и span'ы
этого сервиса теряются. История миграции это уже подтверждала
(см. `docs/architecture-migration-plan/tasks/_carryover-10.md`
§8 #1: retail-микросервис на одной из итераций task-10 не
импортировал tracer первой строкой и не давал span'ов до фикса).

### `export {}` — почему модуль пустой

Последняя строка `tracer.ts` — `export {}`. Это сигнал
TypeScript'у «это модуль, а не скрипт». Иначе модуль попадает в
глобальное пространство имён и `import 'foo/tracer'`-семантика
ломается. Сам файл при этом **ничего не экспортирует** наружу —
он работает побочными эффектами, и это его единственный
интерфейс с приложением. Параллель — `reflect-metadata` в любом
Nest-приложении: тоже side-effect-импорт первой строкой.

### Env-конфигурация: что Joi требует

```typescript
// libs/config/config-module.config.ts (фрагмент)
OTEL_SERVICE_NAME: Joi.string().required(),
OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string()
  .uri({ scheme: ['http', 'https'] })
  .required(),
OTEL_RESOURCE_ATTRIBUTES: Joi.string().optional(),
OTEL_SDK_DISABLED: Joi.boolean().default(false),
```

> [GitHub: libs/config/config-module.config.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/config/config-module.config.ts#L39-L44)

Два обязательных, два опциональных. Если забыть
`OTEL_SERVICE_NAME` — приложение **не стартует** (Joi падает на
boot). Это правильно: трейсы без имени сервиса бесполезны в
Jaeger.

Конкретные значения для каждого сервиса — в
`docker-compose.yml` ([[jaeger-backend]]):
`OTEL_SERVICE_NAME=api-gateway`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/traces`,
и т.д.

### Где `tracer.ts` НЕ переэкспортирован

```typescript
// libs/observability/index.ts
export * from './correlation-id.decorator';
export * from './correlation.constants';
// ...
// `tracer.ts` is a side-effect import only; it is not re-exported here.
// Apps wire it as `import '@retail-inventory-system/observability/tracer';`
// (deep import) at the very top of `main.ts`.
```

> [GitHub: libs/observability/index.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/index.ts#L1-L11)

Это сделано **намеренно**. Если бы `tracer` экспортировался из
barrel'а, то `import { LoggerModuleConfig } from '@retail-inventory-system/observability'`
случайно подтягивал бы и tracer тоже — а на самом деле tracer
нужен только в `main.ts`. Deep-import делает импорт явным:
ты пишешь его руками, ты несёшь ответственность за его место в
файле. Это разовое отклонение от «всегда импортируйте из
barrel'а» — оправданное эффектом side-effect-импорта.

## Связанные решения

- [[pino-logging]] — структурированные JSON-логи поверх Pino;
  параллельная плоскость к OTel.
- [[trace-log-correlation]] — как Pino-hook читает активный
  OTel-span и инжектит `traceId`/`spanId` в каждую строку лога.
- [[jaeger-backend]] — куда летят OTLP-пакеты: collector +
  Jaeger UI + production-swap.
- [[lib-opentelemetry-api]] — публичный API: `trace`,
  `context`, `diag`.
- [[lib-opentelemetry-sdk-node]] — `NodeSDK`-агрегатор.
- [[lib-opentelemetry-auto-instrumentations-node]] — bundle
  патчей под http/mysql2/redis/amqplib/nestjs.
- [[lib-opentelemetry-instrumentation-amqplib]] — отдельная
  инструментация amqplib; единственное, что делает
  cross-service-trace однодеревным.
- [[lib-opentelemetry-exporter-trace-otlp-http]] —
  OTLP/HTTP-exporter к коллектору.
- [[lib-opentelemetry-core]] — context manager, propagator
  (почти всегда транзитивный).
- [[lib-opentelemetry-resources]] — `resourceFromAttributes(...)`.
- [[lib-opentelemetry-semantic-conventions]] — константы
  атрибутов.
- [[shared-libs-philosophy]] — почему именно `libs/observability`
  собирает Pino + OTel.
- [[message-vs-event-patterns]] — какие AMQP-сообщения становятся
  span'ами (и оба типа становятся).
- [[routing-keys-and-contracts]] — как `correlationId` ходит
  параллельно `traceparent`.
- [[hexagonal-architecture]] — почему сами use-case'ы про
  OTel ничего не знают.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| OpenTelemetry (OTel) | Vendor-neutral observability framework CNCF. |
| Span | Одна логическая операция: handler, query, publish. Имеет начало/конец, атрибуты, статус. |
| Trace | Дерево span'ов с общим `traceId`. |
| `traceId` | 128-битный идентификатор trace'а. |
| `spanId` | 64-битный идентификатор span'а. |
| `parentSpanId` | Указатель «выше по call-graph'у». Root-span его не имеет. |
| Context | Невидимый объект, привязанный к async-цепочке (через `AsyncLocalStorage`). Содержит активный span. |
| Active span | Span, который вернёт `trace.getActiveSpan()` в текущем async-контексте. |
| Propagation | Распространение trace-context между процессами. |
| W3C `traceparent` | Стандартный HTTP-header вида `00-<traceId>-<spanId>-<flags>`. |
| Resource | Метаданные сервиса (`service.name`, `deployment.environment.name`), прицепленные ко всем span'ам. |
| Exporter | Компонент SDK, который шлёт span'ы наружу (OTLP/HTTP, OTLP/gRPC, Jaeger-thrift, …). |
| OTLP | OpenTelemetry Protocol: единый бинарный/JSON-формат span'ов. |
| Collector | Отдельный процесс, принимающий OTLP от app'ов и переотправляющий дальше (batch + sample + drop). |
| Auto-instrumentation | Runtime-monkey-patching популярных модулей (`http`, `mysql2`, `redis`, `amqplib`, `nestjs-core`) в момент `require()`. |
| Side-effect import | Импорт ради побочного эффекта; обычно — `import 'foo';` без деструктуризации. |
| `require-in-the-middle` | NPM-пакет, на котором OTel перехватывает `require()`. |
| `NodeSDK` | Класс `@opentelemetry/sdk-node`; собирает exporter + instrumentations + resource. |
| `OTLPTraceExporter` | Класс `@opentelemetry/exporter-trace-otlp-http`; пакует span'ы в OTLP и шлёт по HTTP. |
| `getNodeAutoInstrumentations()` | Функция из `@opentelemetry/auto-instrumentations-node`; возвращает все стандартные инструментации одним массивом. |
| `resourceFromAttributes(...)` | Builder из `@opentelemetry/resources`. |
| `ATTR_SERVICE_NAME` | Константа `'service.name'` из `@opentelemetry/semantic-conventions`. |
| `OTEL_SERVICE_NAME` | Env-var, обязательная. Имя сервиса для атрибутов Resource. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Env-var, обязательная. URL collector'а (должен заканчиваться на `/v1/traces`). |
| `OTEL_SDK_DISABLED` | Env-var, опциональная. `'true'` — короткое замыкание SDK на boot'е (для unit-тестов). |
| `@opentelemetry/instrumentation-amqplib` | Отдельная инструментация amqplib; делает cross-service-trace однодеревным через inject/extract `traceparent` в AMQP-properties. |

> [!faq]- Проверь себя
> 1. Что произойдёт, если переставить
>    `import '@retail-inventory-system/observability/tracer';`
>    с первой строки `main.ts` на вторую (после
>    `import { NestFactory } from '@nestjs/core';`)?
> 2. Почему `tracer.ts` не реэкспортирован из
>    `libs/observability/index.ts`?
> 3. Между двумя service'ами трейс идёт по HTTP — что несёт в
>    себе `traceparent`-header? Между двумя service'ами через
>    RabbitMQ — где живёт тот же `traceparent`?
> 4. Если в Jaeger'е появилось 50% span'ов от ожидаемых, и
>    при этом `OTEL_SDK_DISABLED=false`, какой из четырёх
>    `main.ts` ты будешь проверять в первую очередь и на что?
> 5. Какой пакет даёт `trace.getActiveSpan()` — `@opentelemetry/sdk-node`
>    или `@opentelemetry/api`? И почему именно этот?

## Что почитать дальше

- [OpenTelemetry Concepts](https://opentelemetry.io/docs/concepts/) —
  официальная страница с базовыми сущностями (Span, Trace,
  Context, Resource).
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) —
  спецификация `traceparent`/`tracestate`-заголовков.
- [OpenTelemetry Node.js: Getting Started](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/) —
  bootstrap в Node-сервисе, аналогичный нашему `tracer.ts`.
- [Auto-instrumentation: how it works](https://opentelemetry.io/docs/zero-code/js/) —
  zero-code-инструментация в Node; то, что мы используем
  через bundle.
