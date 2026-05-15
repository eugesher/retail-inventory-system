---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, messaging, patterns, rpc, events]
status: review
related:
  - "[[rabbitmq-as-bus]]"
  - "[[nest-microservices-transport]]"
  - "[[routing-keys-and-contracts]]"
  - "[[hexagonal-architecture]]"
  - "[[api-gateway-pattern]]"
  - "[[microservices-split]]"
---

# `@MessagePattern` vs `@EventPattern`

> [!abstract] Кратко
> Из коробки `@nestjs/microservices` даёт два декоратора:
> `@MessagePattern` для **RPC** (request/response, типизированный
> ответ, ошибки бьют обратно вызывающему) и `@EventPattern` для
> **событий** (fire-and-forget, fan-out, ответа нет). В проекте
> оба паттерна работают по одной RMQ-шине, отличие — на уровне
> producer'а: `ClientProxy.send(...)` ждёт reply,
> `ClientProxy.emit(...)` шлёт и забывает. Канонический пример
> RPC — `retail.order.confirm` (gateway → retail → inventory).
> Канонический пример события — `retail.order.created`
> (retail → notification). Правило выбора простое: если
> caller'у нужен ответ — RPC; если нужно **уведомить кого-то**
> о факте, который уже произошёл — событие.

## Проблема, которую решает

Когда сервис-A хочет, чтобы что-то произошло в сервисе-B, у
автора кода в голове плавают две абсолютно разных вещи:

1. **«Ответь мне, что получилось»** — caller продолжает работу
   только зная результат. Это нужно для бизнес-flow вида
   «подтверди заказ, **зная**, что stock зарезервирован, иначе
   откажи клиенту». Без типизированного ответа невозможно
   решить, что отдать клиенту в HTTP-ответе.
2. **«Я просто уведомляю, что что-то случилось»** — caller'у
   ответ не нужен. Заказ уже создан, БД-транзакция уже
   commit'нута; сейчас задача — сказать миру, чтобы желающие
   могли среагировать. Подписчиков может быть ноль, один или
   три; их количество — деталь, скрытая от producer'а.

Если построить всё на «отдавай ответ всегда» (RPC) — каждый
producer ждёт от каждого consumer'а, и одна тормозящая
подписка валит весь flow. Если построить всё на «уведомил и
забыл» — невозможно реализовать бизнес-flow с зависимостями
типа «сначала зарезервируй stock, потом подтверди заказ».

`@nestjs/microservices` разделяет эти семантики **на уровне
декораторов**, чтобы продумывание «нужен ли ответ» происходило
во время написания handler'а, а не во время отладки flake'ующих
e2e-тестов.

## Концепция

### Технически: оба декоратора ходят через одну очередь

В терминах RabbitMQ обе механики живут на одной шине: producer
кладёт сообщение в exchange, consumer-сервис достаёт из
своей очереди, Nest распаковывает payload и матчит
`pattern`-поле с зарегистрированными handler'ами.

Разница начинается в трёх местах:

- **`ClientProxy.send(pattern, payload)`** против
  **`ClientProxy.emit(pattern, payload)`**. `send` создаёт
  одноразовую reply-очередь, кладёт её имя в
  `replyTo`-property сообщения, ждёт ответ из неё.
  `emit` — обычный publish без reply.
- **`@MessagePattern(...)` handler** должен **возвращать**
  результат (или Promise результата); этот результат Nest
  упакует и отправит в `replyTo`-очередь. **`@EventPattern(...)`
  handler** возвращает что хочет — Nest этот возврат
  игнорирует.
- **Ошибки**. У RPC ошибка handler'а заворачивается в
  RpcException и долетает producer'у; у события ошибка handler'а
  логируется (и в зависимости от `noAck`-стратегии либо
  redeliver'ится, либо отправляется в DLX) — producer о ней
  никогда не узнает.

### RPC: когда caller не может продолжить без ответа

Хорошие RPC-flow'и в проекте отвечают на вопросы вида:

- «Какой остаток у этого товара на этом складе?» —
  `inventory.product-stock.get`. Gateway вернёт клиенту 200 с
  числом; без ответа inventory вернуть нечего.
- «Создай мне заказ и верни его id» — `retail.order.create`.
  Gateway вернёт 201 с `orderId`, который retail сгенерировал
  в БД.
- «Подтверди этот заказ» — `retail.order.confirm`. retail сам
  вызывает inventory RPC'ом (`inventory.order.confirm`), потому
  что без знания, сколько строк подтвердились, шапку заказа
  обновить нельзя.

Общее — caller **не может вернуть осмысленный результат
наружу**, пока не получит ответ от owner'а агрегата. Без RPC
здесь придётся либо городить хитрый async-flow с временным
состоянием в БД, либо просто потерять контракт «клиент
получает результат своего HTTP-запроса». Не стоит.

### Event: когда caller не зависит от того, кто слушает

Хорошие event-flow'и отвечают на вопросы вида:

- «А ну-ка кто-нибудь, отправьте клиенту нотификацию, заказ
  создан» — `retail.order.created`. Retail-микросервис уже
  закоммитил order, его дальше ничего не интересует.
- «Stock упал ниже порога — кто хочет, реагирует» —
  `inventory.stock.low`. Inventory уже зафиксировал
  резервацию в БД; событие — побочный эффект.

Общее — fact (`order created`, `stock dropped low`) уже
произошёл в системе записи (БД commit), и producer
**философски не имеет права** требовать ответа: если consumer
лежит, factual состояние мира всё равно осталось правильным.
Это и есть «post-commit fan-out» — публикация после фиксации
в системе записи.

В проекте сегодня — один consumer на каждое событие
(notification). Но это деталь: завтра подключится аналитика, и
поменять надо будет ноль строк в retail/inventory.

### Anti-pattern 1: «эмулировать ответ через события»

Иногда хочется сделать сделать RPC на событиях: «А пошлю-ка я
`retail.order.confirmation-requested` и подпишусь на
`retail.order.confirmation-completed`». Так в проекте не
делают, потому что:

- появляется два sequence'а (`requested` / `completed`)
  вместо одного round-trip'а;
- timeout'ом нужно следить самому;
- если consumer лёг между `requested` и `completed`,
  producer висит вечно (или строит ещё один уровень — DLX +
  retry + dead-letter handler);
- ровно эту работу `ClientProxy.send` уже делает на
  reply-очереди.

### Anti-pattern 2: «RPC ради уведомления»

Обратный кейс: «Создал заказ, теперь сделаю RPC в
notification, чтобы тот выслал письмо». Так не делают, потому
что:

- notification теперь — критический путь HTTP-ответа. Любой
  его косяк (timeout, упавший SMTP) → клиент видит 500;
- HTTP-ответ задерживается на латентность письма;
- notification получает право срывать commit заказа.

Правильно — order уже сохранён, событие
`retail.order.created` опубликовано (best-effort), HTTP-ответ
отдан. Если notification лежит, заказ всё равно создан.

### Ack-семантика двух паттернов

В `main.ts` микросервисов стоит `noAck: false` (явно для
notification, default для retail/inventory с конфигурацией
RMQ-transport'а). Это значит: каждое сообщение требует явного
ack'а после успешной обработки.

- **RPC.** Nest ack'ает сообщение **после** успешного возврата
  из handler'а и **до** отправки reply. Если handler бросил —
  Nest ack'ает (чтобы сообщение не зацикливалось) и шлёт
  RpcException в reply.
- **Event.** Nest ack'ает сообщение, только если handler
  вернулся без ошибки. Если handler бросил — сообщение
  reject'ится и в зависимости от настроек либо
  redeliver'ится, либо уходит в DLX. В проекте сегодня DLX не
  настроен — событие, на котором handler упал, попадёт в
  retry-цикл (это знакомая «дельта-семантика» RabbitMQ
  `noAck: false`).

Это объясняет, почему в `LogNotifierAdapter` не падает
ничего: handler у нас идемпотентный, ошибок не бросает, и
сообщение успешно ack'ается. Когда подключится `EmailNotifierAdapter`
(сегодня — TODO-scaffold per ADR-011), будет важно обернуть
flaky-операции (SMTP) в правильную retry-стратегию.

## Применение в проекте

### RPC inbound: `retail.order.confirm` приходит в retail

Контроллер на retail-стороне держит три `@MessagePattern`,
включая `RETAIL_ORDER_CONFIRM`:

```typescript
// apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts
@Controller()
export class OrderController {
  constructor(
    private readonly createOrderUseCase: CreateOrderUseCase,
    private readonly confirmOrderUseCase: ConfirmOrderUseCase,
    private readonly getOrderUseCase: GetOrderUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.RETAIL_ORDER_CREATE)
  public async create(
    @Payload(OrderCreatePipe) payload: IOrderCreatePayload,
  ): Promise<OrderCreateResponseDto> {
    return this.createOrderUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_ORDER_CONFIRM)
  public async confirm(
    @Payload(OrderConfirmPipe) order: IOrderConfirm,
  ): Promise<OrderConfirmResponseDto> {
    return this.confirmOrderUseCase.execute(order);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_ORDER_GET)
  public async getById(@Payload() id: number): Promise<{ statusId: OrderStatusEnum } | null> {
    return this.getOrderUseCase.findHeaderById(id);
  }
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts#L1-L42)

Что здесь важно для RPC-семантики:

- **Возврат метода — типизированный**: `OrderConfirmResponseDto`,
  не `void`. Этот тип реально полетит обратно producer'у в
  reply-очередь.
- **`@Payload(OrderConfirmPipe)`** — Nest-pipe валидирует и
  обогащает payload до того, как handler'а позовут. Если pipe
  бросит — пользователь получит ошибку (через RpcException) и
  retail в БД ничего не пишет.
- **`return this.confirmOrderUseCase.execute(order)`** — handler
  тонкий: вся бизнес-логика в use-case'е. Это та же гексагональная
  структура, что и для HTTP-контроллеров.

### RPC outbound: gateway зовёт retail

На gateway-стороне use-case инжектит `RETAIL_GATEWAY_PORT`
(не `ClientProxy`!) и вызывает `confirmOrder(id, correlationId)`.
Адаптер за портом делает RPC:

```typescript
// apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts
public async confirmOrder(id: number, correlationId: string): Promise<OrderConfirmResponseDto> {
  return firstValueFrom(
    this.client.send<OrderConfirmResponseDto, IOrderConfirmPayload>(
      ROUTING_KEYS.RETAIL_ORDER_CONFIRM,
      { id, correlationId },
    ),
  );
}
```

> [GitHub: apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts#L36-L43)

`.send(...)` — это и есть «положи запрос в `retail_queue`,
дождись ответа в reply-очереди, верни его». `firstValueFrom`
поверх Observable превращает это в Promise.

### RPC chain: retail внутри handler'а вызывает inventory RPC

Самый «headline»-сценарий — кросс-сервисный RPC:
gateway → retail → inventory. Use-case retail'а инжектит
`INVENTORY_CONFIRM_GATEWAY`-порт; адаптер за ним — это
`InventoryConfirmRabbitmqAdapter`:

```typescript
// apps/retail-microservice/src/modules/orders/infrastructure/messaging/inventory-confirm.rabbitmq.adapter.ts
@Injectable()
export class InventoryConfirmRabbitmqAdapter implements IInventoryConfirmGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  public async reserveOrderStock(payload: {
    products: IOrderProductConfirm[];
    correlationId: string;
  }): Promise<number[]> {
    return firstValueFrom(
      this.inventoryClient.send<number[], IProductStockOrderConfirmPayload>(
        ROUTING_KEYS.INVENTORY_ORDER_CONFIRM,
        { products: payload.products, correlationId: payload.correlationId },
      ),
    );
  }
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/infrastructure/messaging/inventory-confirm.rabbitmq.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/infrastructure/messaging/inventory-confirm.rabbitmq.adapter.ts#L1-L35)

И use-case использует именно порт, не клиент:

```typescript
// apps/retail-microservice/src/modules/orders/application/use-cases/confirm-order.use-case.ts
let confirmedOrderProductIds: number[];
try {
  confirmedOrderProductIds = await this.inventoryGateway.reserveOrderStock({
    products,
    correlationId,
  });
} catch (error) {
  this.logger.error(
    { err: error as Error, correlationId, orderId: id },
    'Inventory order.confirm RPC failed',
  );
  throw error;
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/application/use-cases/confirm-order.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/application/use-cases/confirm-order.use-case.ts#L37-L52)

Use-case инжектит `INVENTORY_CONFIRM_GATEWAY`, не `ClientProxy`.
Это [[hexagonal-architecture|гексагональная]] граница: в
unit-тесте `ConfirmOrderUseCase` `IInventoryConfirmGatewayPort`
подменяется in-memory-test-double'ом и спецификации проверяют
сценарии «stock confirmed / insufficient / RPC timeout» без
поднятия RabbitMQ. ADR-013 §3 явно отмечает это как причину
вынести порт.

### Event inbound: notification слушает `retail.order.created`

Event-handler выглядит почти так же, как RPC, но возвращает
`Promise<void>`:

```typescript
// apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts
@Controller()
export class OrderEventsConsumer {
  constructor(private readonly useCase: SendOrderNotificationUseCase) {}

  @EventPattern(ROUTING_KEYS.RETAIL_ORDER_CREATED)
  public async onOrderCreated(@Payload() event: IRetailOrderCreatedEvent): Promise<void> {
    await this.useCase.execute(event);
  }
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts#L1-L17)

И отдельный consumer для inventory-событий — та же форма:

```typescript
// apps/notification-microservice/src/modules/notifications/infrastructure/consumers/inventory-events.consumer.ts
@EventPattern(ROUTING_KEYS.INVENTORY_STOCK_LOW)
public async onStockLow(@Payload() event: IInventoryStockLowEvent): Promise<void> {
  await this.useCase.execute(event);
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/infrastructure/consumers/inventory-events.consumer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/infrastructure/consumers/inventory-events.consumer.ts#L1-L17)

Заметьте: consumer **не лежит в `presentation/`**, а в
`infrastructure/consumers/`. ADR-011 §4 объясняет почему:
event-handler — это адаптер от wire-payload к use-case-вызову,
конструктивно тот же, что и `@Controller` для HTTP, но
лежащий по другой шине. `presentation/` зарезервирована под HTTP;
RMQ-handler — это инфраструктурный edge.

### Event outbound: retail публикует, забыв про consumer'а

Producer-сторона события `retail.order.created` — `OrderRabbitmqPublisher`
(полный код см. в [[nest-microservices-transport]]):

```typescript
await firstValueFrom(
  this.notificationClient.emit<void, IRetailOrderCreatedEvent>(
    ROUTING_KEYS.RETAIL_ORDER_CREATED,
    wire,
  ),
);
```

В вызывающем use-case'е событие публикуется **после** успешной
персистенции и **в try/catch**, который ловит publish-failures и
warn-логирует, не выбрасывая ошибку дальше:

```typescript
// apps/retail-microservice/src/modules/orders/application/use-cases/create-order.use-case.ts
try {
  await this.publisher.publishOrderCreated(event, correlationId);
} catch (err) {
  // The response correctness does not depend on the notifier — the
  // order is persisted. Warn-log and continue.
  this.logger.warn(
    { err: err as Error, correlationId, orderId },
    'Failed to publish retail.order.created event',
  );
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/application/use-cases/create-order.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/application/use-cases/create-order.use-case.ts#L52-L72)

Это в чистом виде «event semantics»: каждый publish — best-effort,
ответ не ждётся, factual состояние (order создан) сохраняется
независимо от того, дошло ли событие до notification. Если
понадобится at-least-once-доставка событий (например, для
аудитного консьюмера), появится отдельный ADR про
transactional outbox.

### Аналогичный event-flow: `inventory.stock.low`

Inventory-микросервис публикует `inventory.stock.low`, когда
после резервации post-commit-значение `(productId, storageId)`
падает ниже порога. Publisher делает то же самое — `emit + firstValueFrom`:

```typescript
// apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts
public async publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void> {
  const wire: IInventoryStockLowEvent = {
    productId: event.aggregateId,
    storageId: event.storageId,
    quantity: event.quantity,
    threshold: event.threshold,
    occurredAt: event.occurredAt.toISOString(),
    correlationId: correlationId ?? '',
  };

  // `ClientProxy.emit()` returns a cold Observable; `firstValueFrom`
  // materializes it and waits for the broker ack so application code can
  // await a plain Promise (see _carryover-07 §5 #3).
  await firstValueFrom(
    this.notificationClient.emit<void, IInventoryStockLowEvent>(
      ROUTING_KEYS.INVENTORY_STOCK_LOW,
      wire,
    ),
  );
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts#L1-L49)

Та же mapping-функция (domain-event → wire-DTO), та же
обёртка `emit + firstValueFrom`. Это специально — оба publisher'а
следуют одной форме, чтобы reader мог переключаться между
сервисами без когнитивного оверхеда.

### Health-check: даже ping — это `@MessagePattern`

Маленький, но показательный кейс — health-check
notification-микросервиса. У notification нет HTTP-сервера
(ADR-011 §6), поэтому health тоже едет через RMQ — как RPC:

```typescript
// apps/notification-microservice/src/modules/notifications/presentation/health.controller.ts
@Controller()
export class HealthController {
  @MessagePattern(ROUTING_KEYS.NOTIFICATION_HEALTH_PING)
  public ping(): INotificationHealthResponse {
    return { status: 'ok', service: 'notification-microservice' };
  }
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/presentation/health.controller.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/presentation/health.controller.ts#L1-L20)

Если в будущем gateway получит `GET /health/notification`, он
проксирует HTTP в этот RPC. Здесь handler — это контроллер
`presentation/health`, а не `infrastructure/consumers`: ping —
это **запрос «как ты там»**, а не уведомление о факте.
Семантически он симметричен health-check'у HTTP-приложения,
просто транспорт другой.

### Когда что выбирать — резюме

| Признак | RPC (`@MessagePattern` / `.send`) | Event (`@EventPattern` / `.emit`) |
|---|---|---|
| Producer'у нужен ответ? | Да | Нет |
| Сколько подписчиков на pattern? | Ровно один | Ноль и больше |
| Что произойдёт, если consumer медленный? | Producer блокируется на reply | Producer не замечает |
| Куда уйдёт ошибка consumer'а? | В RpcException producer'у | В лог consumer'а |
| Когда публикуется? | Внутри critical path запроса | Post-commit, после фиксации факта |
| Подходящий пример | `retail.order.confirm`, `inventory.product-stock.get` | `retail.order.created`, `inventory.stock.low` |

## Связанные решения

- [[rabbitmq-as-bus]] — общая шина, по которой едут оба
  паттерна.
- [[nest-microservices-transport]] — `ClientProxy.send` vs
  `.emit`, `firstValueFrom`, граница «`ClientProxy` только в
  адаптере».
- [[routing-keys-and-contracts]] — почему `ROUTING_KEYS.X`,
  а не строки; spec, который синхронизирует
  `ROUTING_KEYS` и `MicroserviceMessagePatternEnum`.
- [[hexagonal-architecture]] — почему confirm-flow вынесен в
  `INVENTORY_CONFIRM_GATEWAY`-порт, и почему это важно для
  тестируемости.
- [[api-gateway-pattern]] — где RPC-цепочка начинается (HTTP →
  gateway → RMQ).
- [[microservices-split]] — где границы между сервисами
  определяют, что станет RPC, а что — событием.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| RPC | Remote Procedure Call. Producer ждёт типизированный ответ от consumer'а. |
| Request/response | Сценарий «запрос → ответ» (синоним RPC в нашей шине). |
| Event | Уведомление о факте; ответа не ждут, подписчиков может быть много (или ноль). |
| Fire-and-forget | Стиль публикации: отправил и не ждёшь ничего. |
| Fan-out | Доставка одного события нескольким consumer'ам. |
| `ClientProxy.send` | Метод producer'а для RPC. Возвращает cold Observable от reply-очереди. |
| `ClientProxy.emit` | Метод producer'а для события. Возвращает cold Observable, который материализуется в Promise broker-ack'а. |
| `@MessagePattern` | NestJS-декоратор для RPC-handler'а. Возвращаемое значение становится reply. |
| `@EventPattern` | NestJS-декоратор для event-handler'а. Возвращаемое значение игнорируется. |
| Reply-очередь | Auto-named очередь под `send`, в которую consumer кладёт ответ. |
| `replyTo` | Свойство AMQP-сообщения с именем reply-очереди. `ClientProxy.send` ставит его автоматически. |
| `noAck: false` | Опция RMQ-transport'а. Сообщение требует явного ack'а после обработки. |
| RpcException | Класс NestJS для ошибок, бросаемых из RPC-handler'а; маршалится через reply. |
| Post-commit publish | Публикация события **после** успешной фиксации состояния в системе записи. |
| Transactional outbox | Паттерн «сохрани событие в той же транзакции с состоянием, опубликуй из таблицы». В проекте сегодня **нет**. |
| Best-effort delivery | Доставка «как сможем»: если consumer лежит, событие может быть потеряно. |

> [!faq]- Проверь себя
> 1. Почему `retail.order.confirm` — RPC, а
>    `retail.order.created` — событие? Что произойдёт, если
>    поменять их местами?
> 2. Где в коде сделана граница «retail RPC'ом ходит в
>    inventory», и почему между retail-use-case'ом и
>    `ClientProxy` стоит порт?
> 3. Что вернёт `ClientProxy.emit(...)` (тип TypeScript)?
>    Почему даже его надо обернуть `firstValueFrom`?
> 4. Почему consumer'ы событий лежат в
>    `infrastructure/consumers/`, а не в `presentation/`?
> 5. Что произойдёт, если ConfirmOrderUseCase убрать `try/catch`
>    вокруг `publishOrderConfirmed`, а сам publish бросит?
>    Какие сценарии станут хуже?

## Что почитать дальше

- [Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/)
  Hohpe & Woolf — каталог паттернов; «Request-Reply» и
  «Event Message» — точные первоисточники терминов.
- [Microservices Patterns](https://microservices.io/patterns/index.html)
  Chris Richardson — раздел «Communication patterns»,
  особенно «Asynchronous messaging» и «Domain event».
