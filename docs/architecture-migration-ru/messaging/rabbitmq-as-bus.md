---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, messaging, rabbitmq]
status: final
related:
  - "[[nest-microservices-transport]]"
  - "[[message-vs-event-patterns]]"
  - "[[routing-keys-and-contracts]]"
  - "[[microservices-split]]"
  - "[[api-gateway-pattern]]"
  - "[[shared-libs-philosophy]]"
---

# RabbitMQ как шина межсервисных сообщений

> [!abstract] Кратко
> Все четыре процесса Retail Inventory System
> (`api-gateway`, `retail-microservice`,
> `inventory-microservice`, `notification-microservice`)
> общаются друг с другом **исключительно через RabbitMQ** — и
> для RPC (request/response), и для событий (fire-and-forget).
> Один брокер, поднимаемый `docker-compose`, переменная
> окружения `RABBITMQ_URL` и три долгоживущие durable-очереди
> на сервис-приёмник: `retail_queue`, `inventory_queue`,
> `notification_events`. Топик-exchange'ей в проекте сейчас
> нет — каждая очередь привязана к default-exchange по имени;
> зато в `libs/messaging` зарезервированы константы `EXCHANGES`
> под будущую миграцию на routing по шаблону. Выбор RabbitMQ
> зафиксирован в [ADR-020](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/020-rabbitmq-as-inter-service-bus.md);
> wiring через `libs/messaging` — в [ADR-008](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/008-rabbitmq-via-libs-messaging.md).

## Проблема, которую решает

В системе четыре отдельных процесса, и они должны общаться:

- **API Gateway** принимает HTTP от клиента, аутентифицирует
  его и адресует команду в нужный микросервис: «создай
  заказ» → retail, «покажи остаток товара» → inventory.
- **Retail microservice** владеет агрегатом `Order`. При
  подтверждении заказа он должен **спросить** inventory: «есть
  ли свободный stock на эти SKU», и дождаться ответа. Это
  request/response, по сути — синхронный RPC.
- **Inventory microservice** владеет агрегатом `StockItem`.
  Когда после резервации `(productId, storageId)` остаток
  опускается ниже порога, он **уведомляет** систему — но не
  знает заранее, кто слушает. Это fire-and-forget событие.
- **Notification microservice** не оригиналит ни одной
  команды. Он только слушает события (`retail.order.created`,
  `inventory.stock.low`) и отправляет нотификации (сегодня —
  в лог через `LogNotifierAdapter`; завтра — email/webhook).

Если выбрать прямые HTTP-вызовы между сервисами, на каждом
edge придётся ставить retry, circuit breaker, service
discovery и думать, что делать, когда target-сервис лёг или
медленно отвечает. Если выбрать «толстый» брокер вроде Kafka
— нужны ZooKeeper/KRaft, schema registry, consumer-group
offsets и оперативная экспертиза, которой у проекта из одного
человека нет. Хочется **одно** решение, которое:

1. развязывает producer и consumer (producer не знает, сколько
   подписчиков, и не ждёт их);
2. одинаково обслуживает RPC и события (чтобы не таскать два
   разных клиента);
3. естественно интегрируется с `@nestjs/microservices` и
   позволяет писать handler'ы рядом с другими модулями;
4. живёт в одном Docker-контейнере локально и в одном
   managed-инстансе в проде.

Под все четыре требования подходит RabbitMQ. ADR-020 формализует
выбор; альтернативы (Kafka, NATS, Redis Streams, gRPC, прямой
HTTP) подробно разобраны там же с причинами отказа.

## Концепция

### Зачем вообще брокер

В монолите межмодульная коммуникация — это вызовы функций
внутри одного процесса; всё в одном `node` runtime'е, ошибка —
исключение, ответ — `return`. Как только домены разъезжаются по
процессам (микросервисы), способов соединить их два:

- **Direct call** — HTTP/gRPC/что угодно поверх TCP. Producer
  держит адрес consumer'а, ждёт ответ, обрабатывает таймаут.
  Любой сетевой блип превращается в ошибку в бизнес-логике.
- **Брокер посередине** — producer пишет в shared очередь,
  брокер хранит сообщение до момента, когда consumer его
  заберёт. Producer не блокируется на «consumer жив или нет»,
  consumer не блокируется на «producer не молчит ли».

RabbitMQ — реализация AMQP 0-9-1, брокер вторая школа. Producer
публикует в **exchange**, exchange по правилам **routing**
кладёт копию в одну или несколько **queue**, consumer читает из
queue. У RabbitMQ есть четыре основных типа exchange'ей:

- **direct** — сообщение уходит в очередь, чьё binding-имя
  буквально совпадает с routing key;
- **topic** — routing key соответствует шаблону binding
  (`inventory.*.low`, `retail.order.#`);
- **fanout** — broadcast всем привязанным очередям;
- **default** (безымянный direct) — для каждой очереди есть
  «бесплатный» binding с её именем как routing key. Это то,
  что Retail Inventory System использует сегодня.

### Default exchange и одна очередь на сервис

Default exchange — это служебный direct-exchange, к которому
RabbitMQ автоматически биндит каждую новосозданную очередь по
её имени. Когда producer публикует с routing-key
`retail_queue`, сообщение приходит в очередь
`retail_queue`. Когда producer публикует с routing-key
`retail.order.create`, сообщение приходит в очередь, которую
вы явно привязали к этому ключу.

`@nestjs/microservices` идёт ещё проще: пара
`(transport: Transport.RMQ, queue: <name>)` означает «создай
durable-очередь с этим именем и слушай её». Все consumer'ы
сервиса попадают в одну очередь, а routing внутри неё делает
сам Nest: он смотрит поле `pattern` в payload-конверте и
вызывает handler, у которого `@MessagePattern(<pattern>)` или
`@EventPattern(<pattern>)` совпал.

Это значит, что:

- producer не настраивает exchange'ы — он отправляет в
  default-exchange с routing-key, равным `queueName`;
- consumer не описывает binding'и — Nest подписывается на
  целую очередь и распаковывает `pattern` сам;
- маршрутизация между разными handler'ами одного сервиса
  происходит **внутри** процесса, а не внутри RabbitMQ.

У этого подхода есть плата: вы теряете естественный
topic-routing (нельзя подписать notification на «все
`inventory.*.low`-события» отдельной очередью без явных
binding'ов). Сегодня notification получает события по тем же
routing-key'ам, но обрабатывает их в одном процессе. Если в
будущем понадобится разделить consumer'ов на разные
sub-сервисы или хочется wildcard-подписок, в `libs/messaging`
уже зарезервированы топик-exchange имена.

### Брокер как один контейнер

RabbitMQ в проекте — один контейнер, одна координата
`RABBITMQ_URL`. Образ `rabbitmq:4.2.3-management` поднимает и
сам брокер (5672), и веб-UI (15672 — `guest/guest` локально):

```yaml
# docker-compose.yml
services:
  rabbitmq:
    image: rabbitmq:4.2.3-management
    container_name: rabbitmq
    ports:
      - '5672:5672'
      - '15672:15672'
    environment:
      RABBITMQ_DEFAULT_USER: guest
      RABBITMQ_DEFAULT_PASS: guest
    healthcheck:
      test: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping']
```

> [GitHub: docker-compose.yml](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docker-compose.yml#L1-L20)

Контейнер с healthcheck'ом — все четыре app-сервиса в том же
compose-файле ждут `rabbitmq.condition: service_healthy`,
поэтому ни один app не стартует «до брокера». В проде это
managed-RabbitMQ; ни один app-код не зависит от того,
self-hosted это контейнер или CloudAMQP — все ходят по
`amqp://`-URL.

## Применение в проекте

### `RABBITMQ_URL` — единая точка конфигурации

Все четыре process'а читают одну переменную окружения. Joi-схема
в `libs/config` валидирует её при boot'е приложения и при
запуске CLI-миграций — отсутствие переменной валит процесс на
старте, а не на первом `ClientProxy.send`:

```typescript
// libs/config/config-module.config.ts
RABBITMQ_URL: Joi.string().uri({ scheme: 'amqp' }).required(),
```

> [GitHub: libs/config/config-module.config.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/config/config-module.config.ts#L18-L18)

В compose-файле та же переменная пробрасывается каждому app:

```yaml
# docker-compose.yml — фрагмент окружения api-gateway
environment:
  RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
```

> [GitHub: docker-compose.yml](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docker-compose.yml#L72-L72)

Локально без Docker (`.env.local`) — `amqp://guest:guest@localhost:5672`.

### Очередь на каждый микросервис-приёмник

Имена очередей живут одним enum'ом в
`libs/contracts/microservices`:

```typescript
// libs/contracts/microservices/microservice-queue.enum.ts
export enum MicroserviceQueueEnum {
  INVENTORY_QUEUE = 'inventory_queue',
  RETAIL_QUEUE = 'retail_queue',
  NOTIFICATION_EVENTS = 'notification_events',
}
```

> [GitHub: libs/contracts/microservices/microservice-queue.enum.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/microservices/microservice-queue.enum.ts#L1-L5)

Inventory и retail слушают одноимённые очереди; notification —
`notification_events`. Имя — единственная договорённость между
producer'ом и consumer'ом на уровне транспорта; всё остальное
(routing keys, форма payload'а) описывается на уровне выше — в
`libs/messaging` и `libs/contracts/microservices`. См.
[[routing-keys-and-contracts]].

### Bootstrap: микросервис привязывается к очереди

В `main.ts` каждого микросервиса используется
`NestFactory.createMicroservice` с `Transport.RMQ`. Очередь и
URL берутся из enum'а и `ConfigService`:

```typescript
// apps/inventory-microservice/src/main.ts
const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
  bufferLogs: true,
  transport: Transport.RMQ,
  options: {
    urls: [configService.get<string>('RABBITMQ_URL')!],
    queue: MicroserviceQueueEnum.INVENTORY_QUEUE,
    queueOptions: { durable: true },
  },
});

app.useLogger(app.get(Logger));

await app.listen();
```

> [GitHub: apps/inventory-microservice/src/main.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/main.ts#L18-L30)

Ключевое:

- `queueOptions: { durable: true }` — очередь переживает
  рестарт брокера. Сообщения, отправленные туда, не теряются,
  пока consumer перезагружается. Это default-выбор для всех
  трёх очередей.
- `queue: MicroserviceQueueEnum.INVENTORY_QUEUE` — одна
  очередь на весь микросервис. Все `@MessagePattern` /
  `@EventPattern` handler'ы внутри `AppModule` подписаны на
  один и тот же поток сообщений; Nest диспетчеризует их
  внутри процесса.
- `noAck: false` (default для retail/inventory, явно для
  notification — см. ниже) — каждое сообщение подтверждается
  явно после успешной обработки. Если handler упал —
  сообщение возвращается в очередь и доставляется снова.

Notification-микросервис ставит `noAck: false` явно, чтобы
event-handler ack'ал только после успешного `send` в
notifier-адаптер:

```typescript
// apps/notification-microservice/src/main.ts
options: {
  urls: [configService.get<string>('RABBITMQ_URL')!],
  noAck: false,
  queue: MicroserviceQueueEnum.NOTIFICATION_EVENTS,
  queueOptions: { durable: true },
},
```

> [GitHub: apps/notification-microservice/src/main.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/main.ts#L20-L26)

API Gateway — единственный process, который **не** вызывает
`createMicroservice` (он HTTP-сервер). Он только публикует —
через `ClientProxy`, см. [[nest-microservices-transport]].

### Producer'ы: `RmqOptions` через библиотечную фабрику

Когда сервис должен говорить в чужую очередь, он не создаёт
RmqOptions руками. В `libs/messaging` есть конфигурация,
которую переиспользуют все ClientsModule-обёртки:

```typescript
// libs/messaging/microservice-client.configuration.ts
export class MicroserviceClientConfiguration implements ClientsProviderAsyncOptions {
  public readonly useFactory: ClientsProviderAsyncOptions['useFactory'];

  public readonly inject = [ConfigService];

  constructor(
    public readonly name: MicroserviceClientTokenEnum,
    queue: MicroserviceQueueEnum,
  ) {
    this.useFactory = (configService: ConfigService): RmqOptions => ({
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        queueOptions: { durable: true },
        queue,
      },
    });
  }
}
```

> [GitHub: libs/messaging/microservice-client.configuration.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/messaging/microservice-client.configuration.ts#L1-L27)

Один класс описывает, как асинхронно собрать `RmqOptions` под
конкретную (token, queue)-пару. Поверх него лежат три
ClientsModule-обёртки — по одной на каждый сервис-приёмник:
`MicroserviceClientRetailModule`,
`MicroserviceClientInventoryModule`,
`MicroserviceClientNotificationModule`. Сервис, которому нужен
`ClientProxy` для retail, импортирует первый из них; для
notification — третий. Это то самое
«[[shared-libs-philosophy|чужие технические детали — за
библиотечную обёртку]]».

Подробнее про сам `ClientProxy`, его Observable-семантику и
правило «адаптер — единственное место, где живёт
`@nestjs/microservices`», — см. [[nest-microservices-transport]].

### Зарезервированные `EXCHANGES`-константы

Сегодня каждая очередь привязана к default-exchange по имени.
Но routing-key'и проекта уже выбраны в **dotted**-формате —
`retail.order.create`, `inventory.stock.low` — именно для того,
чтобы AMQP topic-routing работал, когда понадобится. Места под
имена топик-exchange'ей зарезервированы:

```typescript
// libs/messaging/exchanges.constants.ts
export const EXCHANGES = {
  RETAIL: 'retail',
  INVENTORY: 'inventory',
  NOTIFICATION: 'notification',
} as const;

export type Exchange = (typeof EXCHANGES)[keyof typeof EXCHANGES];
```

> [GitHub: libs/messaging/exchanges.constants.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/messaging/exchanges.constants.ts#L1-L10)

Сейчас ни один адаптер на них не ссылается — это маркер
интенции, а не активный код. В тот момент, когда
notification-сервис захочет получать только события вида
`inventory.*.low`, а аналитика — `retail.order.#`, переезд
сведётся к:

1. Объявить топик-exchange `inventory` в брокере (или дать
   Nest'у сделать это через расширенные опции AMQP).
2. Описать binding'и: `inventory_queue` — на `inventory.*.low`,
   `analytics_queue` — на `retail.order.#`.
3. Поменять адаптеры publisher'а так, чтобы они публиковали в
   exchange по имени, а не в default-exchange по имени
   очереди.

Никакой бизнес-логики менять не придётся — routing-key'и
уже корректны (см. [[routing-keys-and-contracts]]).

### Failure-семантика: RPC и события — разные правила

RabbitMQ обеспечивает at-least-once доставку с явными ack
сообщений. На уровне приложения failure-семантика двух
паттернов отличается:

- **RPC** (`@MessagePattern` + `ClientProxy.send`). Ошибка в
  handler'е превращается в `RpcException` на producer'е, и
  gateway транслирует её в HTTP-ошибку через `throwRpcError`.
  Если consumer недоступен — `ClientProxy.send` ждёт ответ до
  таймаута и завершается с ошибкой; gateway отдаёт 504-эквивалент.
- **Событие** (`@EventPattern` + `ClientProxy.emit`). Сегодня
  публикация события post-commit'но — order уже сохранён,
  stock уже зарезервирован. Если publish провалился, use-case
  логирует warn и продолжает; см.
  `CreateOrderUseCase` ниже. Это **best-effort** доставка
  событий — гарантий «order создан ⇒ notification получен» нет.

Транзакционного outbox в проекте сегодня нет. ADR-020 явно
держит дверь открытой: если кросс-сервисная at-least-once
гарантия станет жёстким требованием, появится отдельный
ADR. Сейчас приоритет — не блокировать RPC-ответ на сетевой
блип брокера.

### `correlationId` и `traceparent` — два разных канала

Каждый payload (`IOrderCreatePayload`, `IInventoryStockLowEvent`,
…) расширяет `ICorrelationPayload`:

```typescript
// libs/contracts/microservices/correlation.types.ts
export interface ICorrelationPayload {
  correlationId: string;
}
```

> [GitHub: libs/contracts/microservices/correlation.types.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/microservices/correlation.types.ts#L1-L7)

`correlationId` проставляет gateway-middleware'а на входе HTTP,
и адаптеры (`RetailRabbitmqAdapter`,
`InventoryRabbitmqAdapter`) передают его в payload. Каждая
Pino-строка логов несёт этот же id; задача — собирать
кросс-сервисный лог по нему в Loki/ELK.

Параллельно — `traceparent` (W3C trace context) пробрасывается
**не через payload**, а через AMQP message properties. Это
делает OpenTelemetry-инструментация `amqplib`
автоматически — см. [[trace-log-correlation]]. Реализация
живёт в `libs/observability/tracer.ts`; адаптеру не нужно
ничего знать про OTel — патч `amqplib` срабатывает по факту
`require()` и хукает publish/consume.

## Связанные решения

- [[nest-microservices-transport]] — как именно
  `@nestjs/microservices` оборачивает `amqplib`,
  `ClientProxy`, `firstValueFrom` и правило
  «`ClientProxy` — только в `infrastructure/messaging/`».
- [[message-vs-event-patterns]] — RPC vs event, на каких
  flow'ах используются и почему.
- [[routing-keys-and-contracts]] — dotted-конвенция
  routing-key'ев, `ROUTING_KEYS`, `MicroserviceMessagePatternEnum`
  и spec, который синхронизирует их.
- [[microservices-split]] — как четыре process'а разбиты по
  доменам; шина — следствие этой границы.
- [[api-gateway-pattern]] — где gateway сидит на этой шине
  как только-producer.
- [[shared-libs-philosophy]] — почему `@nestjs/microservices`
  и `amqplib` собраны в `libs/messaging`, а не в каждом app.
- [[trace-log-correlation]] — как `traceparent` пересекает
  RabbitMQ-границы (вне body payload'а).

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Message broker | Брокер сообщений — посредник между producer и consumer, который хранит сообщение, пока его не заберут. |
| RabbitMQ | Брокер сообщений, реализация AMQP 0-9-1. Выбран в [ADR-020](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/020-rabbitmq-as-inter-service-bus.md). |
| AMQP | Advanced Message Queuing Protocol — открытый протокол брокеров сообщений. |
| Exchange | Точка маршрутизации в AMQP. Producer публикует в exchange, exchange по правилам кладёт сообщение в очередь. |
| Default exchange | Безымянный direct-exchange, к которому каждая очередь привязана по своему имени. |
| Topic exchange | Exchange, который матчит routing-key по шаблонам (`*` — одно слово, `#` — ноль или больше). |
| Queue | Очередь сообщений. Consumer читает из неё в порядке FIFO (с приоритетами как опцией). |
| Durable queue | Очередь, переживающая рестарт брокера. У всех трёх очередей проекта `durable: true`. |
| `RABBITMQ_URL` | Connection string в формате `amqp://user:pass@host:port`. Joi-валидируется при boot. |
| `Transport.RMQ` | Идентификатор RMQ-транспорта в `@nestjs/microservices`. |
| `RmqOptions` | Тип-конфиг для RMQ-транспорта (`urls`, `queue`, `queueOptions`, `noAck`, ...). |
| `MicroserviceQueueEnum` | Enum имён очередей. Канонический источник в `libs/contracts/microservices`. |
| `EXCHANGES` | Frozen `as const`-объект имён exchange'ей. Зарезервирован под будущий topic-routing. |
| `noAck` | Опция RMQ-transport'а. `false` — handler явно ack'ает после успешной обработки. |
| At-least-once | Гарантия доставки: сообщение будет доставлено хотя бы один раз (возможны дубликаты). Default RabbitMQ. |
| Transactional outbox | Паттерн «сохрани событие в той же транзакции, что и состояние, и публикуй из таблицы». В проекте сегодня **нет**. |
| `ICorrelationPayload` | Интерфейс `{ correlationId: string }`; каждый wire-payload его расширяет. |
| `traceparent` | Заголовок W3C trace context. Пробрасывается через AMQP message properties OTel-инструментацией. |

> [!faq]- Проверь себя
> 1. Почему в проекте всего один брокер на четыре сервиса, а
>    не выделенная пара брокер-на-домен?
> 2. Что произойдёт, если notification-микросервис будет лежать
>    в момент, когда retail публикует `retail.order.created`?
>    А если в этот момент лежит брокер?
> 3. Чем отличается `queue: 'retail_queue'` от
>    `pattern: 'retail.order.create'` в контексте маршрутизации?
> 4. Почему `EXCHANGES`-константы есть, но ни один адаптер их
>    не использует?
> 5. Как одна и та же `RABBITMQ_URL`-переменная одновременно
>    конфигурирует и `createMicroservice` в `main.ts`, и
>    `ClientsModule.registerAsync` в библиотечных модулях?

## Что почитать дальше

- [RabbitMQ Tutorials (официальные)](https://www.rabbitmq.com/tutorials)
  — седьмой урок про topic-exchanges релевантен, когда будете
  поднимать routing по шаблону.
- [AMQP 0-9-1 Model Explained](https://www.rabbitmq.com/tutorials/amqp-concepts)
  — короткое введение в exchange/queue/binding.
- [NestJS Microservices: RabbitMQ](https://docs.nestjs.com/microservices/rabbitmq)
  — официальный гид; покрывает то же, что и
  [[nest-microservices-transport]], но без проектной
  специфики.
