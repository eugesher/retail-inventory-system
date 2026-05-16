---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, observability, library, otel, exporter]
status: review
related:
  - "[[opentelemetry-overview]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-sdk-node]]"
  - "[[lib-opentelemetry-api]]"
  - "[[lib-opentelemetry-core]]"
  - "[[lib-opentelemetry-resources]]"
---

# Библиотека: @opentelemetry/exporter-trace-otlp-http

> [!abstract] Кратко
> `@opentelemetry/exporter-trace-otlp-http@^0.218.0` — это
> **только** один компонент: `OTLPTraceExporter`-класс,
> который сериализует span'ы в формат OTLP (бинарный protobuf
> или JSON), упаковывает в HTTP-`POST`-запрос и шлёт на
> `OTEL_EXPORTER_OTLP_ENDPOINT` (по умолчанию
> `http://localhost:4318/v1/traces`). В проекте — одна
> строка в `tracer.ts`: `new OTLPTraceExporter()`. Все
> детали (endpoint, timeout, headers) читаются из env-vars,
> которые SDK подхватывает за нас. [ADR-014](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/014-otel-exporter-otlp-http-and-jaeger.md)
> выбирает именно HTTP (не gRPC, не Jaeger-thrift) из-за
> простоты deps + дебага.

## Проблема, которую решает

После того как SDK ([[lib-opentelemetry-sdk-node]])
сгенерил span'ы и накопил их в `BatchSpanProcessor`,
кто-то должен **отправить** их наружу. Этот «кто-то» —
exporter. У OTel есть несколько exporter'ов:

- `@opentelemetry/exporter-trace-otlp-http` (HTTP/JSON);
- `@opentelemetry/exporter-trace-otlp-grpc` (gRPC);
- `@opentelemetry/exporter-trace-otlp-proto` (HTTP/protobuf);
- `@opentelemetry/exporter-zipkin` (Zipkin-формат);
- `@opentelemetry/exporter-jaeger` (Jaeger-thrift, legacy).

[ADR-014](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/014-otel-exporter-otlp-http-and-jaeger.md)
выбирает **OTLP/HTTP** по трём причинам:

- **Одна зависимость, никаких native-сборок.** OTLP/gRPC
  потащил бы `@grpc/grpc-js`, protobuf-codegen, native-bindings.
  HTTP — просто `http`-модуль Node'а.
- **Простой дебаг.** `curl -X POST http://otel-collector:4318/v1/traces \
  -H 'Content-Type: application/json' -d @body.json` —
  ровно то, что шлёт SDK. `tcpdump` против gRPC тяжелее.
- **Identical end-state.** Коллектор турнит OTLP/HTTP в всё
  что угодно дальше — Jaeger/OTLP, Tempo, Honeycomb,
  Datadog. Latency-разница между HTTP и gRPC на наших
  volume'ах пренебрежимо мала.

## Применение в проекте

### Где подключается

```typescript
// libs/observability/tracer.ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

// OTLPTraceExporter respects OTEL_EXPORTER_OTLP_ENDPOINT and
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT; passing an explicit url is optional.
const traceExporter = new OTLPTraceExporter();

const sdk = new NodeSDK({
  resource,
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});
```

> [GitHub: libs/observability/tracer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/tracer.ts#L18-L53)

`new OTLPTraceExporter()` без аргументов. Конфигурация —
**через env-vars**:

| Env-var | Что задаёт | У нас |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base-URL коллектора | `http://otel-collector:4318/v1/traces` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Override per-signal (если разный endpoint для traces vs metrics) | Не задаём |
| `OTEL_EXPORTER_OTLP_HEADERS` | Кастомные headers (`x-honeycomb-team` и т.п.) | Не задаём (collector handles auth) |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Timeout одного export'а в ms | Default 10s |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `none` или `gzip` | Default `none` |

В нашем `docker-compose.yml`:

```yaml
environment:
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318/v1/traces
```

> [GitHub: docker-compose.yml](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docker-compose.yml#L74-L75)

Endpoint **должен** заканчиваться на `/v1/traces` (path для
traces-signal'а; для metrics было бы `/v1/metrics`, для logs —
`/v1/logs`). Joi-схема в `libs/config/config-module.config.ts`
просто требует URL — суффикс не проверяет, но это
ответственность ops'ов.

### Что в HTTP-запросе

Тип сообщения — `application/json` (по умолчанию). SDK
сериализует пачку span'ов в JSON OTLP-формата, делает
`POST`, ждёт `200 OK` от коллектора. Пример (упрощённо):

```http
POST /v1/traces HTTP/1.1
Host: otel-collector:4318
Content-Type: application/json
Content-Length: 1234

{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "api-gateway" } },
          { "key": "deployment.environment.name", "value": { "stringValue": "development" } }
        ]
      },
      "scopeSpans": [
        {
          "scope": { "name": "@opentelemetry/instrumentation-http" },
          "spans": [
            {
              "traceId": "1a2b…",
              "spanId": "0001…",
              "name": "POST /api/order",
              "kind": "SPAN_KIND_SERVER",
              "startTimeUnixNano": "...",
              "endTimeUnixNano": "...",
              "attributes": [
                { "key": "http.method", "value": { "stringValue": "POST" } },
                { "key": "http.target", "value": { "stringValue": "/api/order" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

`resourceSpans` — внешняя обёртка с метаданными сервиса
(`service.name` приходит из [[lib-opentelemetry-resources]]
и [[lib-opentelemetry-semantic-conventions]]). Внутри —
`scopeSpans` (per-инструментация), внутри — собственно
span'ы.

### Поведение при ошибках

Если коллектор лежит:

- `OTLPTraceExporter` возвращает rejected-promise;
- `BatchSpanProcessor` логирует ошибку через `diag` (включается
  `OTEL_DIAG_LOG_LEVEL=debug` — см. [[lib-opentelemetry-api]]);
- **batch теряется**. Retry-policy в этом exporter'е минимальный
  (нет exponential-backoff, нет dead-letter). Если нужна
  гарантированная доставка — это **ответственность коллектора**,
  не приложения.

Это by design: приложение должно жить дальше даже если
observability-стек упал; обратное — наоборот, было бы
проблемой («не могу ответить на HTTP-запрос, потому что
Jaeger лежит»).

### `:4318` vs `:4317`

Default-порт OTLP/HTTP — `:4318`; OTLP/gRPC — `:4317`. Наш
`otel-collector` (см. [[jaeger-backend]]) слушает оба, но
приложения шлют **только на `:4318`** через этот exporter.
Если бы мы хотели свапнуть на gRPC, пришлось бы:

1. Установить `@opentelemetry/exporter-trace-otlp-grpc`;
2. Заменить `new OTLPTraceExporter()` на новый класс из
   нового пакета;
3. Поменять env-var endpoint на `:4317`.

Три точки изменения, все в `tracer.ts` + `docker-compose.yml`.
App-код **не меняется** — благодаря API/SDK-разделению
([[lib-opentelemetry-api]]).

## Что этот пакет НЕ делает

- **Не экспортирует logs или metrics.** Для них —
  `@opentelemetry/exporter-logs-otlp-http` и
  `@opentelemetry/exporter-metrics-otlp-http`. Они не
  установлены: ADR-001 ставит Pino как наш log-stack, а
  metrics через OTel мы не используем (плейсхолдер
  `libs/observability/metrics.module.ts` — empty).
- **Не делает retry с backoff.** Один batch — один HTTP-вызов;
  upon failure — drop. Retries оставлены коллектору.
- **Не делает sampling.** Sampling — отдельная задача в SDK
  ([[lib-opentelemetry-sdk-node]]).
- **Не подписывает запросы TLS-ом из коробки.** Если бы
  endpoint был `https://`, SDK бы автоматически использовал
  TLS — но в нашем случае это `http://otel-collector:4318`
  внутри docker-сети, без TLS. В prod-конфиге endpoint
  меняется на TLS-вариант (vendor дает `https://...`).
- **Не отправляет на vendor напрямую (в нашем дизайне).**
  Apps шлют **только** на `otel-collector`. Vendor видит
  span'ы от **коллектора**, не от приложения. Этим
  обеспечивается vendor-neutrality в коде ([[jaeger-backend]]
  §«Production swap»).
- **Не выбирает между JSON и protobuf автоматически.** Этот
  пакет — `*-otlp-http` — шлёт **JSON**. Если бы нужен
  protobuf-over-HTTP — отдельный пакет
  `@opentelemetry/exporter-trace-otlp-proto`. У нас JSON
  достаточно: дебагabable, ~10% больше по размеру.

## Связанные решения

- [[opentelemetry-overview]] — что такое exporter в общем
  потоке span'ов.
- [[jaeger-backend]] — receiver на стороне коллектора и
  что коллектор делает дальше.
- [[lib-opentelemetry-sdk-node]] — куда передаётся
  `traceExporter` в качестве аргумента.
- [[lib-opentelemetry-api]] — `diag`-канал для exporter-ошибок.
- [[lib-opentelemetry-core]] — propagator и context-manager,
  на которые exporter полагается транзитивно.
- [[lib-opentelemetry-resources]] — где `service.name`
  попадает в `resourceSpans`.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@opentelemetry/exporter-trace-otlp-http` | OTLP-over-HTTP-exporter для span'ов. |
| `OTLPTraceExporter` | Класс exporter'а. Конструктор без аргументов = читать env-vars. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Env-var: base-URL коллектора. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Per-signal override. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Custom headers (для vendor-auth, не используем). |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Timeout одного export'а. Default 10s. |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `none` или `gzip`. У нас default. |
| `:4318` | Default-порт OTLP/HTTP. |
| `:4317` | Default-порт OTLP/gRPC (мы не используем). |
| `/v1/traces` | Path для traces-signal'а. |
| OTLP/JSON | JSON-сериализация OTLP. Что использует этот пакет. |
| OTLP/protobuf | Бинарная сериализация OTLP. Отдельный пакет. |
| `resourceSpans` | Внешняя обёртка JSON-payload'а: метаданные сервиса + scope-spans. |
| Retry | Не делается exporter'ом; ответственность коллектора. |
| TLS | HTTPS не настроен для local-dev; в prod — настраивается через `OTEL_EXPORTER_OTLP_ENDPOINT=https://...`. |

> [!faq]- Проверь себя
> 1. Какой content-type идёт по умолчанию: JSON или protobuf?
>    Как сменить?
> 2. Что произойдёт, если коллектор лежит 30 секунд? Что
>    видит operator в логах приложения?
> 3. Я хочу засылать трейсы напрямую в Honeycomb (вместо
>    коллектора). Какие env-vars поменять и какие сохранить
>    как есть?
> 4. На каком HTTP-методе и path-е работает OTLP/HTTP?
> 5. Зачем `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`-override,
>    если есть `OTEL_EXPORTER_OTLP_ENDPOINT`?

## Что почитать дальше

- [OTLP Specification](https://opentelemetry.io/docs/specs/otlp/) —
  формат wire-payload'а.
- [`@opentelemetry/exporter-trace-otlp-http` README](https://www.npmjs.com/package/@opentelemetry/exporter-trace-otlp-http) —
  список опций конструктора и env-vars.
- [Collector exporters configuration](https://opentelemetry.io/docs/collector/configuration/#exporters) —
  что коллектор делает с прилетающим OTLP/HTTP.
