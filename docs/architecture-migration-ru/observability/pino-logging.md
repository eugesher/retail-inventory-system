---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, observability, pino, logging]
status: final
related:
  - "[[opentelemetry-overview]]"
  - "[[trace-log-correlation]]"
  - "[[jaeger-backend]]"
  - "[[shared-libs-philosophy]]"
  - "[[routing-keys-and-contracts]]"
  - "[[message-vs-event-patterns]]"
  - "[[api-gateway-pattern]]"
---

# Структурированное логирование с Pino

> [!abstract] Кратко
> Все четыре сервиса проекта пишут JSON-логи через **Pino**
> (через `nestjs-pino` обёртку для DI). Каждая строка содержит
> `level`, `time`, `app`, `msg` и — внутри HTTP-request'а —
> `correlationId` (UUID v4), пробрасываемый по
> `x-correlation-id`-заголовку. `CorrelationMiddleware`
> либо принимает входящий header, либо генерит UUID; далее
> ID живёт в request-scope, попадает в response-header и в
> payload RabbitMQ-сообщений. `LoggerModuleConfig` —
> единственное место в репозитории, где Pino настраивается:
> level из `LOG_LEVEL`, redaction `Authorization`/`Cookie`,
> `pino-pretty` в dev, и `logMethod`-hook, дополнительно
> инжектящий `traceId`/`spanId` ([[trace-log-correlation]]).

## Проблема, которую решает

Без структурированных логов отладка распределённой системы
выглядит так:

```
[Nest] LOG [OrderCreateService] Order created
[Nest] LOG [ProductStockOrderConfirmService] Stock reserved
```

Никакой машинной обработки: нет request-scope, нет полей,
нет уровня в виде enum'а. Невозможно построить алёрт «логов
с `error` за последние 5 минут больше 10», невозможно
сделать `jq 'select(.correlationId == "X")'`, чтобы вытащить
весь след запроса.

[ADR-001](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/001-structured-logging-with-pino.md)
решает обе проблемы одним выбором: **Pino как logger**, и
**`correlationId` через middleware** на gateway-входе. Pino —
самый быстрый JSON-logger в Node-экосистеме (по benchmark'ам
быстрее Winston в 3–5×), а его API через `nestjs-pino`-обёртку
встраивается в Nest-DI без церемоний.

## Концепция

### Слои стека

Pino в нашем стеке — это **четыре** NPM-зависимости, плюс
одна `libs/observability`-обёртка, плюс одна middleware'а:

| Слой | Пакет | Роль |
|---|---|---|
| App-вход | `LoggerModule.forRoot(...)` из `nestjs-pino` | Регистрирует Nest-DI-провайдер `Logger`. |
| Конфиг | `LoggerModuleConfig` из `libs/observability` | Единственное место, где задаются level, redact, transport, hooks. |
| HTTP-middleware | `pino-http` (под капотом nestjs-pino) | Создаёт per-request logger с автоматическим `req.id` и timing'ом. |
| Реализация | `pino` | JSON-вывод, levels, redaction, `mixin`, `hooks`. |
| Dev-форматтер | `pino-pretty` | Cветовой человекочитаемый вывод (только в dev). |

`nestjs-pino` — это **просто** тонкая Nest-обёртка над `pino` +
`pino-http`. Она даёт `LoggerModule.forRoot(params)`,
inject'ит `Logger`/`PinoLogger` через DI, и стандартный
Nest-`app.useLogger(...)` начинает писать через Pino.

### Структура лога

Базовый формат строки — JSON с предсказуемыми полями:

```json
{
  "level": 30,
  "time": 1762000000000,
  "app": "api-gateway",
  "msg": "[api-gateway] HTTP request completed",
  "req": { "method": "POST", "url": "/api/order" },
  "res": { "statusCode": 201 },
  "responseTime": 142,
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "traceId": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "spanId": "1234567890abcdef"
}
```

- `level` — числовой (Pino пишет цифры, не строки: 30=info,
  40=warn, 50=error; `pino-pretty` восстанавливает строки в dev).
- `time` — epoch-ms; `pino-pretty` рендерит человеческое
  время в dev, прод оставляет epoch для парсеров.
- `app` — `AppNameEnum` (`api-gateway` / `retail-microservice`
  / `inventory-microservice` / `notification-microservice`).
- `correlationId` — request-scope-идентификатор; см. ниже.
- `traceId`/`spanId` — OTel-поля, инжектятся `logMethod`-hook'ом;
  см. [[trace-log-correlation]].

### `correlationId`: жизненный цикл

Идея — **один UUID на запрос**, пробрасываемый через все
четыре сервиса. Жизненный цикл:

1. HTTP-вход на gateway. Middleware читает заголовок
   `x-correlation-id` (если клиент его прислал) или генерит
   UUID v4 — и echo'ит его обратно в response-header.
2. Контроллер gateway вызывает use-case; use-case инжектит
   `IRetailGatewayPort`/`IInventoryGatewayPort`, передаёт
   `correlationId` в payload.
3. Adapter (`RetailRabbitmqAdapter` и т.п.) кладёт
   `correlationId` в RabbitMQ-payload — это поле описано в
   `ICorrelationPayload` ([[routing-keys-and-contracts]]).
4. Микросервис-handler читает `correlationId` из payload и
   **явно** передаёт его в `logger.info({ correlationId, ... })`.

Шаг 4 — это та самая «дисциплина из ADR-001»: микросервисы
не могут использовать `logger.assign({ correlationId })`, потому
что они исполняются вне HTTP-request-scope'а — `AsyncLocalStorage`
для них не инициализирован тем же путём, что для gateway.
Это **сознательный trade-off**: одна строчка `correlationId` в
каждом `logger.info`-вызове — цена за единый идентификатор.

### Redaction: что не попадёт в логи

```typescript
redact: {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
  ],
  remove: true,
},
```

`remove: true` означает «не подменяй на `[Redacted]`, а удали
поле вовсе». Это критично: `[Redacted]`-маркер всё ещё
сигнализировал бы log-aggregator'у, что `authorization`
существовал — а нам нужно, чтобы Bearer-token'ов в логах не
было физически. Параллель с ADR-010 ([[api-gateway-pattern]]):
JWT в логах = риск утечки.

### `LOG_LEVEL` и режимы

```typescript
level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
```

В dev — `debug` (всё, что можно). В prod — `info` (без debug-spam'а).
`LOG_LEVEL` env var переопределяет — рантайм-debug без передеплоя.

`pino-pretty` подключается только в **не-prod** (через
`transport.target: 'pino-pretty'`). В prod — голый JSON в
stdout, поток подхватывает `docker logs` / Loki / Datadog.

### `logMethod`: hook на каждый вызов

```typescript
hooks: {
  logMethod(inputArgs, method, level) {
    // 1) drop noisy framework contexts in dev
    if (!isProduction && level === levels.values.info &&
        NOISY_CONTEXTS.has((inputArgs[0]).context)) {
      return;
    }

    // 2) inject active OTel span IDs (ADR-015)
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext?.traceId && spanContext.spanId) {
      const enrichment = { traceId: spanContext.traceId, spanId: spanContext.spanId };
      // ... merge into first arg
    }

    method.apply(this, inputArgs);
  },
}
```

Hook делает **две** вещи разом:

- **Фильтрует noise** — `InstanceLoader`, `NestFactory`,
  `RouterExplorer`, `RoutesResolver`, `NestApplication`,
  `NestMicroservice` — Nest'ов framework-spam про
  «загружен модуль X», «зарегистрирован route Y». В prod
  оставляем (полезно для observability стартапа); в dev
  выкидываем.
- **Инжектит** `traceId`/`spanId` из активного OTel-span'а.
  Это контракт ADR-015 — подробно в [[trace-log-correlation]].

Два concern'а в одном hook'е — потому что Pino позволяет
зарегистрировать **один** `logMethod` per-config. Распиливать
его не имеет смысла: оба условия дешёвые (set-lookup и
`trace.getActiveSpan()`), оба ранятся per-record.

## Применение в проекте

### `LoggerModuleConfig` — единая точка истины

```typescript
// libs/observability/logger.module.ts
export class LoggerModuleConfig implements Params {
  public readonly pinoHttp: Options;
  public readonly forRoutes: Parameters<MiddlewareConfigProxy['forRoutes']>;

  constructor(appName: AppNameEnum) {
    const isProduction = process.env.NODE_ENV === 'production';
    const customProps = { app: appName };

    this.forRoutes = [{ path: '*path', method: RequestMethod.ALL }];

    this.pinoHttp = {
      msgPrefix: `[${appName}] `,
      level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
      customProps: (): { app: AppNameEnum } => customProps,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
      hooks: {
        logMethod(inputArgs, method, level) { /* ... */ },
      },
      ...(isProduction ? {} : { transport: { target: 'pino-pretty', /* ... */ } }),
    };
  }
}
```

> [GitHub: libs/observability/logger.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/logger.module.ts#L22-L80)

`AppNameEnum` (`api-gateway`, `retail-microservice` и т.д.) —
параметр конструктора. Так один и тот же config параметризуется
под каждый сервис без копи-пасты: `LoggerModuleConfig` —
**class with state**, а не функция-фабрика, чтобы Nest мог
прокинуть один и тот же `Params`-объект и в
`LoggerModule.forRoot(...)`, и в `new PinoLogger(...)` boot-time.

### Boot: дважды используется один и тот же config

`LoggerModuleConfig` инстанцируется **дважды**:

1. В `main.ts` — для `PinoLogger`, который пишет
   bootstrap-логи **до** того, как Nest поднялся:

   ```typescript
   // apps/api-gateway/src/main.ts
   const logger = new PinoLogger(new LoggerModuleConfig(AppNameEnum.API_GATEWAY));
   // ...
   logger.info(`API Gateway is running on port: ${port}`);
   ```

   > [GitHub: apps/api-gateway/src/main.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/main.ts#L15-L43)

2. В `AppModule` — через `LoggerModule.forRoot(...)`, чтобы
   Nest-DI инжектил `Logger`/`PinoLogger`:

   ```typescript
   // apps/api-gateway/src/app/app.module.ts
   LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.API_GATEWAY)),
   ```

   > [GitHub: apps/api-gateway/src/app/app.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/app/app.module.ts#L20)

После `await NestFactory.create(...)` Nest подменяет boot-time
`PinoLogger` на DI-version (`app.useLogger(app.get(Logger))`).
Это два разных инстанса, но **один и тот же config** —
никакой разницы для read'ера логов.

### `CorrelationMiddleware`: HTTP-вход

```typescript
// libs/observability/http-context.middleware.ts
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  public use(req: Request, res: Response, next: NextFunction): void {
    const correlationId = (req.headers[CORRELATION_ID_HEADER] as string) || randomUUID();
    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  }
}
```

> [GitHub: libs/observability/http-context.middleware.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/http-context.middleware.ts#L1-L20)

Десять строк, две инварианта:

- `req.headers[CORRELATION_ID_HEADER]` всегда установлен после
  middleware (либо клиентский, либо UUID v4).
- `response.setHeader('x-correlation-id', ...)` echo'ит
  значение обратно — клиент может его залогировать.

Подключается в `AppModule.configure(...)`:

```typescript
// apps/api-gateway/src/app/app.module.ts
public configure(consumer: MiddlewareConsumer): void {
  consumer.apply(CorrelationMiddleware).forRoutes('*path');
}
```

> [GitHub: apps/api-gateway/src/app/app.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/app/app.module.ts#L31-L34)

`'*path'` — Nest-syntax «все routes». В микросервисах
`CorrelationMiddleware` **не подключается** — там HTTP-входа
нет, и middleware не имеет смысла.

### `CORRELATION_ID_HEADER`: одна константа

```typescript
// libs/observability/correlation.constants.ts
export const CORRELATION_ID_HEADER = 'x-correlation-id';
```

> [GitHub: libs/observability/correlation.constants.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/correlation.constants.ts#L1)

Один файл, одна строка. Принцип «не повторяй магическую
строку» в действии: `'x-correlation-id'` упоминается в
middleware, в decorator'е, в integration-тестах — везде
через константу.

### `@CorrelationId()` — param-decorator

```typescript
// libs/observability/correlation-id.decorator.ts
export const CorrelationId = createParamDecorator(
  (_, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<Request>().headers[CORRELATION_ID_HEADER] as string,
);
```

> [GitHub: libs/observability/correlation-id.decorator.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/correlation-id.decorator.ts#L1-L9)

Удобство: HTTP-controller инжектит `correlationId` как
параметр handler'а, без `request.headers[...]`-кода:

```typescript
@Post()
public create(
  @Body() dto: OrderCreateDto,
  @CorrelationId() correlationId: string,
) { /* ... */ }
```

В контроллере `correlationId` сразу типизирован и доступен —
дальше передаётся в use-case → payload RabbitMQ.

### `ICorrelationPayload`: cross-service

Тип `ICorrelationPayload` живёт в `libs/contracts`
(реэкспортирован из `libs/observability` для удобства):

```typescript
// libs/observability/correlation.types.ts
export { ICorrelationPayload } from '@retail-inventory-system/contracts';
```

> [GitHub: libs/observability/correlation.types.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/observability/correlation.types.ts#L1-L5)

Все RPC- и event-сообщения через RabbitMQ имеют поле
`correlationId: string` в payload. Микросервисы читают его и
**явно** прокидывают в каждый `logger.info({ correlationId, ... })` —
см. [[routing-keys-and-contracts]].

## Связанные решения

- [[opentelemetry-overview]] — параллельная плоскость
  observability'и; вместе с Pino даёт полную картину.
- [[trace-log-correlation]] — `logMethod`-hook, инжектящий
  `traceId`/`spanId` в каждый Pino-record (ADR-015).
- [[jaeger-backend]] — куда уходят OTel-span'ы; в логах их
  ID совпадают с теми, что показывает Jaeger UI.
- [[shared-libs-philosophy]] — почему `libs/observability`
  держит и Pino, и OTel в одной библиотеке.
- [[routing-keys-and-contracts]] — `ICorrelationPayload`,
  правило «`correlationId` в каждом RMQ-payload».
- [[message-vs-event-patterns]] — оба класса RMQ-handler'ов
  пишут логи с `correlationId`.
- [[api-gateway-pattern]] — gateway как единственная точка
  входа `correlationId` (UUID v4 рождается там).

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Pino | Самый быстрый JSON-logger в Node-экосистеме. |
| `nestjs-pino` | Nest-обёртка над `pino` + `pino-http`. `LoggerModule.forRoot(params)`, `Logger`/`PinoLogger` через DI. |
| `pino-http` | HTTP-middleware от Pino: per-request logger, auto req.id, request-time. |
| `pino-pretty` | Dev-форматтер: цветной человекочитаемый вывод; в prod **не** активен. |
| `LoggerModuleConfig` | Класс из `libs/observability/logger.module.ts`. Единственное место конфигурации Pino. |
| `Params` (`nestjs-pino`) | Интерфейс, который реализует `LoggerModuleConfig`. |
| `PinoLogger` | Класс из `nestjs-pino`. Используется boot-time в `main.ts` до подъёма Nest-DI. |
| `Logger` (`nestjs-pino`) | Nest-DI-провайдер, инжектируемый как `app.useLogger(app.get(Logger))`. |
| `customProps` | Pino-опция: статические поля на каждой строке (`app: 'api-gateway'`). |
| `redact` | Pino-опция: пути полей, которые удаляются или маскируются. |
| `remove: true` | Опция `redact`'а: удалить поле целиком, не заменять на `[Redacted]`. |
| `hooks.logMethod` | Pino-hook, ранящийся **per log call**. Подменяет аргументы перед записью. |
| `transport.target` | Pino-опция: пакет-форматтер. У нас в dev — `'pino-pretty'`. |
| `LOG_LEVEL` | Env-var. Переопределяет дефолт `info` (prod) / `debug` (dev). |
| `correlationId` | UUID v4 на запрос. Genrated by `CorrelationMiddleware`. |
| `x-correlation-id` | HTTP-header, в котором живёт `correlationId`. Echo'ится в response. |
| `CORRELATION_ID_HEADER` | Константа `'x-correlation-id'` из `libs/observability/correlation.constants.ts`. |
| `CorrelationMiddleware` | NestJS-middleware. Читает или генерит `correlationId`. |
| `@CorrelationId()` | Param-decorator из `libs/observability/correlation-id.decorator.ts`. |
| `ICorrelationPayload` | Cross-service payload-contract из `libs/contracts`; поле `correlationId: string`. |
| `logger.assign(...)` | Pino-метод: привязка полей к request-scope через `AsyncLocalStorage`. Используется только на gateway. |
| `AsyncLocalStorage` | Node-API для async-scoped state; основа per-request-полей `pino-http`. |
| `AppNameEnum` | Enum `api-gateway` / `retail-microservice` / `inventory-microservice` / `notification-microservice`. |
| `NOISY_CONTEXTS` | Set из `LoggerModuleConfig`: Nest-context'ы, которые в dev фильтруются hook'ом. |

> [!faq]- Проверь себя
> 1. Почему `level` в логе — число `30`, а не строка `'info'`?
>    Где число превращается в строку?
> 2. Когда поле `correlationId` появляется в логе
>    HTTP-handler'а на gateway — до или после
>    `CorrelationMiddleware`?
> 3. Микросервис получил RabbitMQ-сообщение без поля
>    `correlationId` в payload (старый producer). Что попадёт
>    в его лог?
> 4. Зачем `redact.remove: true`, если `[Redacted]` —
>    тоже маскировка? Какой риск он закрывает?
> 5. `LOG_LEVEL=trace` в проде — что увидит read'ер логов и
>    какой риск это создаёт?

## Что почитать дальше

- [Pino docs](https://getpino.io/) — официальная страница;
  особенно секции «Redaction» и «Hooks».
- [`nestjs-pino` README](https://github.com/iamolegga/nestjs-pino) —
  как подменяется Nest-`Logger`, как настраивается per-request
  scope через `AsyncLocalStorage`.
- [W3C Correlation-ID conventions](https://www.w3.org/TR/trace-context/#trace-id) —
  как `traceparent` и `correlationId` сосуществуют без
  конфликта (ответ — они на разных «осях»: один для humans,
  второй для OTel).
