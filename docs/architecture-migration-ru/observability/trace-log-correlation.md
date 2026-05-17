---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, observability, correlation, otel, pino]
status: final
related:
  - "[[opentelemetry-overview]]"
  - "[[pino-logging]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-api]]"
  - "[[lib-opentelemetry-sdk-node]]"
  - "[[shared-libs-philosophy]]"
  - "[[routing-keys-and-contracts]]"
  - "[[api-gateway-pattern]]"
---

# Корреляция трейсов и логов

> [!abstract] Кратко
> Когда у нас одновременно живут Pino-логи и OTel-span'ы,
> возникает естественный вопрос: «какие логи относятся к
> этому трейсу?». Решение из [ADR-015](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/015-pino-trace-correlation.md):
> один `logMethod`-hook в `LoggerModuleConfig` читает
> `trace.getActiveSpan()?.spanContext()` на **каждый**
> `logger.*`-вызов и инжектит `{ traceId, spanId }` в record.
> Если span не активен — passthrough, никакого `traceId: undefined`.
> Имена `traceId`/`spanId` (camelCase) намеренно отличаются
> от OTel-default'ов `trace_id`/`span_id` (snake_case), чтобы
> сочетаться с остальными полями (`correlationId`, `userId`,
> `orderId`). `correlationId` и `traceId` остаются **обоими** —
> отвечают на разные вопросы.

## Проблема, которую решает

[ADR-001](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/001-structured-logging-with-pino.md)
дал `correlationId` ([[pino-logging]]) — human-grepable
идентификатор на request-scope. [ADR-007](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/007-pino-and-opentelemetry.md)
и [ADR-014](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/014-otel-exporter-otlp-http-and-jaeger.md)
дали OTel-span'ы ([[opentelemetry-overview]] +
[[jaeger-backend]]) — `traceId` на call-graph-scope.

Без дополнительного wiring'а две плоскости лежат **рядом**, но
не пересекаются. Operator смотрит в Jaeger, видит проблемный
trace `1a2b3c…`, и тут возникает вопрос: «**какие логи**
эмитили эти span'ы?». Чтобы найти их в Loki/Datadog/`jq`,
оператор должен:

- либо запросить логи по `correlationId` (но он не показан в
  Jaeger UI; пришлось бы зайти в Pino-логи **сначала**,
  чтобы узнать `correlationId` из span'а — chicken-and-egg);
- либо вручную сопоставлять `time`-окно span'а и логов.

Решение, которое выбрал [ADR-015](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/015-pino-trace-correlation.md):
**инжектить `traceId`/`spanId`** прямо в Pino-record. Тогда:

- `Jaeger UI → traceId → jq 'select(.traceId == "1a2b3c…")'` —
  одно действие, одна plain string;
- логи, не относящиеся к запросу (boot, scheduled job без
  span'а), остаются чистыми — без шумных `traceId: undefined`.

## Концепция

### `logMethod` — где живёт enrichment

Pino даёт несколько способов добавить поля в log-record:

| Способ | Когда вычисляется | Стоимость на запись |
|---|---|---|
| `customProps` | **На boot'е**, один раз | 0 (просто merge статики) |
| `mixin` | **Per record**, before write | ~ функция-зов на каждую строку |
| `hooks.logMethod` | **Per record**, before write, **полный доступ к args** | ~ функция-зов + возможность мутировать args |

`customProps` исключён сразу — `getActiveSpan()` не статичен,
он зависит от текущего async-контекста. `mixin` и `logMethod`
оба ранятся per-call, но `logMethod` даёт **больше**: он видит
все args (`logger.info({ ... }, 'message')` → `[{...}, 'message']`)
и может их подменять. Это полезно, чтобы корректно работать
с обоими формами вызова — `logger.info({...})` и
`logger.info('plain string')`.

### Что hook делает шаг за шагом

```typescript
// libs/observability/logger.module.ts
hooks: {
  logMethod(inputArgs: Parameters<LogFn>, method: LogFn, level: number): void {
    if (
      !isProduction &&
      level === levels.values.info &&
      NOISY_CONTEXTS.has((inputArgs[0] as Record<string, unknown>).context as string)
    ) {
      return;
    }

    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext?.traceId && spanContext.spanId) {
      const first = inputArgs[0];
      const enrichment = { traceId: spanContext.traceId, spanId: spanContext.spanId };

      if (typeof first === 'object' && first !== null) {
        inputArgs[0] = { ...enrichment, ...(first as Record<string, unknown>) };
      } else {
        inputArgs.unshift(enrichment);
      }
    }

    method.apply(this, inputArgs);
  },
}
```

> [GitHub: libs/observability/logger.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/logger.module.ts#L40-L64)

Прочитаем сверху вниз:

1. **Drop noisy framework contexts.** Если dev и `info`-record
   с context'ом из `NOISY_CONTEXTS` — `return` без вызова
   `method`. Это первый concern hook'а (ADR-001 «framework noise
   suppression»), он жил тут до OTel-enrichment'а.
2. **Get active span context.** `trace.getActiveSpan()` —
   функция из `@opentelemetry/api` ([[lib-opentelemetry-api]]).
   Возвращает span или `undefined`. `?.spanContext()` —
   `SpanContext` с `traceId`/`spanId`/`traceFlags`.
3. **Guard на валидность.** Если `traceId`/`spanId` —
   non-empty (т.е. span реально активен и SDK работает), —
   делаем enrichment. Если span не активен (boot-time, тесты
   без SDK) — пропускаем, **без `traceId: undefined`**.
4. **Merge.** Если первый аргумент — объект, делаем
   `{ ...enrichment, ...first }` (`...first` перекрывает
   `enrichment`, чтобы поле `traceId` из самого вызова
   победило hook-инжект — на сегодня такого нет, но контракт
   корректный). Если первый аргумент — строка (`logger.info('msg')`),
   `unshift`'им enrichment-объект в начало.
5. **Call original method.** `method.apply(this, inputArgs)` —
   передаём управление Pino'у.

### Почему именно `logMethod`, а не другой seam

Из [ADR-015](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/015-pino-trace-correlation.md)
§«Hook is the right seam»:

- Hook ранится **на момент записи**, не «снаружи». Это даёт
  гарантию, что `getActiveSpan()` вернёт **тот** span, в
  котором мы прямо сейчас. `mixin` тоже подходил бы, но
  `logMethod` уже использовался для другой цели (drop noise)
  — естественно совместить.
- Хук — **library code**. Каждый сервис автоматически
  получает поведение, импортируя `LoggerModuleConfig`. App-side
  wiring'а нет.
- Композиция: drop-noise-branch и trace-enrichment-branch
  спокойно живут в одной функции — оба per-record, оба
  short-circuit'абельны.

### CamelCase vs snake_case: намеренный divergence

OTel в wire-format'е использует snake_case (`trace_id`,
`span_id`). [ADR-015](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/015-pino-trace-correlation.md#field-naming)
сознательно выбирает camelCase (`traceId`, `spanId`):

| Поле | Источник | Convention |
|---|---|---|
| `correlationId` | naming-convention проекта | camelCase |
| `userId` | naming-convention проекта | camelCase |
| `orderId` | naming-convention проекta | camelCase |
| `traceId` | hook | camelCase (этот ADR) |
| `spanId` | hook | camelCase (этот ADR) |

Альтернатива (`trace_id`/`span_id`) читалась бы как «foreign
body» в `jq`-запросах. Если в проекте однажды установится
`@opentelemetry/instrumentation-pino` (auto-инжект тех же ID,
но в snake_case), наш hook становится **избыточным** — и
тогда удаляется. Сегодня этой инструментации в `package.json`
нет, поэтому два contention'а соседствовать не будут.

### `correlationId` + `traceId`: два идентификатора, две задачи

> [!note] Зачем оба
> Два ID на одной строке — это **не дублирование**.
> Они отвечают на разные вопросы.

| Поле | Источник | Lifetime | Кто читает |
|---|---|---|---|
| `correlationId` | gateway middleware или клиентский header | request, ровно один | человек: `jq 'select(.correlationId == "...")'`, integration-тесты с фиксированным ID |
| `traceId` | OTel-context (`trace.getActiveSpan()`) | один trace; может включать несколько `correlationId` в batch-flow'ах | машина: Jaeger UI, OTel-aware sink'и |

Сегодня для синхронного gateway→retail→inventory→notification
запроса `correlationId` ↔ `traceId` 1:1. Но в потенциальном
будущем — scheduled job без HTTP-request'а **не имеет**
`correlationId` (некому его сгенерить — middleware'ы там нет),
но **имеет** `traceId` (OTel запустит span сам). Обратно: batch
flow «один CSV → 1000 sub-requests» может ходить с одним
`correlationId` и эмитить 1000 разных trace'ов. Эти случаи
сегодня не реализованы, но удаление `correlationId` после
прихода OTel **отвергнуто** [ADR-015](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/015-pino-trace-correlation.md#alternatives)
— чтобы избежать обратной редизайна-боли.

### Стоимость hook'а

`trace.getActiveSpan()` без SDK — `undefined` в одну
JIT-проверку. С SDK — чтение из `AsyncLocalStorage`, тоже
`O(1)`. На unit-тестах, которые не bootstrap'ят OTel,
hook фактически no-op (guard на `spanContext?.traceId`
короткозамыкает). Performance-overhead — ниже одного
микросекунда per call.

## Применение в проекте

### Unit-тест, который анкорит контракт

```typescript
// libs/observability/spec/logger.module.spec.ts
describe('LoggerModuleConfig — trace-correlation hook', () => {
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  const tracerProvider = new BasicTracerProvider();
  trace.setGlobalTracerProvider(tracerProvider);
  const tracer = trace.getTracer('logger-module.spec');

  // ...

  it('injects active span traceId/spanId into a record-style log call', () => {
    const { hook, captured } = buildHook();
    const span = tracer.startSpan('test-span');
    context.with(trace.setSpan(context.active(), span), () => {
      const expected = span.spanContext();
      hook(
        [{ context: 'TestCtx', userId: 'u-1' }, 'hello'],
        function (this: unknown, ...a: unknown[]) {
          captured.args = a;
        } as never,
        30,
      );

      expect(captured.args).not.toBeNull();
      const record = captured.args![0] as Record<string, unknown>;
      expect(record.traceId).toBe(expected.traceId);
      expect(record.spanId).toBe(expected.spanId);
      expect(record.userId).toBe('u-1');
      expect(record.context).toBe('TestCtx');
    });
    span.end();
  });

  it('skips enrichment when no span is active', () => { /* ... */ });
});
```

> [GitHub: libs/observability/spec/logger.module.spec.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/spec/logger.module.spec.ts#L1-L74)

Тест строит **реальный** `BasicTracerProvider` + `AsyncLocalStorageContextManager`,
стартует span через `context.with(...)`, и проверяет:

- `record.traceId` равен `span.spanContext().traceId`;
- `record.spanId` равен `span.spanContext().spanId`;
- **существующие** поля (`userId`, `context`) сохранены —
  hook их не затёр.

Второй тест — passthrough: без активного span'а `traceId` в
record'е **отсутствует** (не `undefined`, не пустая строка).
Это и есть гарантия: «boot-логи останутся чистыми».

Тест полезен ровно как «behaviour-anchor» — он ловит
случайные регрессии, если кто-то завтра решит «упростить»
hook. Сам же end-to-end (real SDK → real Jaeger → join по
`traceId`) проверяется руками через `docker-compose.observability.yml`
([[jaeger-backend]]).

### Как это выглядит в логе

Запрос `POST /api/order` через все четыре сервиса оставляет
строки вида (упрощённо):

```json
{ "level": 30, "app": "api-gateway",            "correlationId": "abc-123", "traceId": "1a2b…", "spanId": "01…", "msg": "Order create requested" }
{ "level": 30, "app": "retail-microservice",    "correlationId": "abc-123", "traceId": "1a2b…", "spanId": "02…", "msg": "Order persisted"          }
{ "level": 30, "app": "inventory-microservice", "correlationId": "abc-123", "traceId": "1a2b…", "spanId": "03…", "msg": "Stock reserved"           }
{ "level": 30, "app": "notification-microservice", "correlationId": "abc-123", "traceId": "1a2b…", "spanId": "04…", "msg": "Notification dispatched" }
```

Четыре сервиса, четыре разных `spanId`, один и тот же
`traceId` — потому что `traceparent` пробросился через
RabbitMQ ([[opentelemetry-overview]] §«Propagation»). И тот же
`correlationId` — потому что он лежит в `ICorrelationPayload`
каждого AMQP-message'а ([[routing-keys-and-contracts]]).

`jq 'select(.traceId == "1a2b…")'` теперь возвращает **все
четыре** строки, и они же — все span'ы того же trace'а в
Jaeger UI.

### Где hook **не** работает

Hook завязан на `trace.getActiveSpan()`. Span может быть
неактивным в следующих случаях:

1. **Boot-time-логи.** До `sdk.start()` (но он стартует
   синхронно в `tracer.ts`, так что окно крошечное), или в
   логах самого `tracer.ts` (которых там и нет).
2. **`OTEL_SDK_DISABLED=true`.** В unit-тестах. SDK не
   зарегистрирован, `getActiveSpan()` всегда `undefined`.
3. **Async-context был утерян** — теоретический риск, если
   код пишет `setImmediate` без правильного
   `context.bind(...)`. Auto-instrumentation работает с
   `AsyncLocalStorage` корректно для `http`/`amqplib`/`mysql2`,
   но custom-async-границы (workers, EventEmitter без bind'а)
   могут уронить контекст.

В случаях (1) и (2) hook корректно сделает passthrough — это
явное поведение, не баг. Случай (3) — пока теоретический;
auto-instrumentation покрывает все async-границы, которые
сегодня есть в коде.

### `TraceContextInterceptor`: placeholder, не путать

В `libs/observability/trace-context.interceptor.ts` живёт
ещё один interceptor — но он **passthrough**:

```typescript
@Injectable()
export class TraceContextInterceptor implements NestInterceptor {
  public intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}
```

[ADR-015](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/015-pino-trace-correlation.md#no-http-response-header-for-traceparent-today)
§«No HTTP response header for `traceparent` today» объясняет:
auto-instrumentation HTTP-сервера сама уже инжектит
`traceparent` в outbound HTTP responses, наш custom поверх рискнул
бы её затереть. Если когда-нибудь понадобится custom-форма
заголовка, в этот interceptor приходит тело. Сегодня он —
заготовка, оставленная намеренно, чтобы app-модули могли его
зарегистрировать без churn'а.

## Связанные решения

- [[opentelemetry-overview]] — общий обзор OTel-стека; trace
  + span; контекст; propagation.
- [[pino-logging]] — Pino-стек; где живёт `LoggerModuleConfig`;
  `correlationId`-thread.
- [[jaeger-backend]] — куда улетают span'ы; что показывает UI.
- [[lib-opentelemetry-api]] — `trace.getActiveSpan()`,
  `SpanContext` — публичный API, откуда hook берёт данные.
- [[lib-opentelemetry-sdk-node]] — SDK, без которого
  `getActiveSpan()` возвращает `undefined`.
- [[shared-libs-philosophy]] — `libs/observability` как
  единая home для Pino + OTel + correlation.
- [[routing-keys-and-contracts]] — `correlationId` на стороне
  RabbitMQ (`ICorrelationPayload`).
- [[api-gateway-pattern]] — gateway, где correlation-thread
  начинается.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `logMethod` (Pino-hook) | Pino-hook, ранящийся **per log call**. Может мутировать args. |
| `customProps` (Pino) | Альтернатива: статические props на boot'е. Не подходит для активного span'а. |
| `mixin` (Pino) | Альтернатива: функция-add'ер полей. Per-record, без доступа к args. |
| `trace.getActiveSpan()` | Функция из `@opentelemetry/api`. Возвращает активный span или `undefined`. |
| `SpanContext` | Объект `{ traceId, spanId, traceFlags, isRemote? }`. |
| `traceId` (поле в логе) | CamelCase идентификатор trace'а. Наш выбор vs snake_case. |
| `spanId` (поле в логе) | CamelCase идентификатор span'а. |
| `trace_id`/`span_id` | OTel-default snake_case. У нас **не** используется; зарезервировано под `instrumentation-pino`, если будет. |
| `correlationId` | Human-grepable идентификатор request-scope'а. Существует независимо от OTel. |
| `BasicTracerProvider` | Класс для unit-тестов: minimal-SDK без exporter'а. |
| `AsyncLocalStorageContextManager` | `@opentelemetry/context-async-hooks`-class; делает `getActiveSpan()` рабочим в async-цепочках. |
| `context.with(trace.setSpan(...), () => {...})` | Идиома OTel: «исполни callback в контексте, где этот span активен». |
| Passthrough | Поведение hook'а: «не модифицировать args, вызвать method как есть». |
| `TraceContextInterceptor` | Nest-interceptor из `libs/observability`. Сегодня passthrough; ADR-015 объясняет, почему. |
| `@opentelemetry/instrumentation-pino` | Альтернативный путь: auto-inject `trace_id`/`span_id`. Не установлен; hook делает то же руками. |
| `NOISY_CONTEXTS` | Set Nest-context'ов, фильтруемых hook'ом в dev: `InstanceLoader`, `NestFactory`, `RouterExplorer`, `RoutesResolver`, `NestApplication`, `NestMicroservice`. |

> [!faq]- Проверь себя
> 1. В hook'е есть `{ ...enrichment, ...(first as Record<string, unknown>) }`.
>    Что произойдёт, если в самом `logger.info({ traceId: 'fake' }, '...')`
>    передать `traceId` руками? Кто победит — фейк или живой OTel?
> 2. На сервере без `import '@retail-inventory-system/observability/tracer';`
>    что увидит read'ер в логах в поле `traceId`?
> 3. Почему **в одной строке лога** живут и `correlationId`, и
>    `traceId`? Назовите запрос, где они дадут разный результат.
> 4. Если завтра установить `@opentelemetry/instrumentation-pino`,
>    что произойдёт с полями нашего hook'а? Что с полями
>    auto-инструментации?
> 5. Зачем в `logger.module.spec.ts` используется
>    `BasicTracerProvider`, а не настоящий `NodeSDK`?

## Что почитать дальше

- [ADR-015 — Pino trace correlation](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/015-pino-trace-correlation.md) —
  полный список альтернатив и обоснование camelCase-выбора.
- [OTel JS API — `trace`](https://opentelemetry.io/docs/languages/js/instrumentation/#acquiring-a-tracer) —
  как достать активный span; что есть `SpanContext`.
- [Pino hooks](https://github.com/pinojs/pino/blob/main/docs/api.md#hookslogmethod-function) —
  официальная страница `logMethod`-hook'а.
- [`@opentelemetry/context-async-hooks`](https://www.npmjs.com/package/@opentelemetry/context-async-hooks) —
  почему именно `AsyncLocalStorage` лежит в основе active-span'а
  в Node.
