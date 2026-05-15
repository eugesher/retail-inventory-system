---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, messaging, nest, nestjs-microservices]
status: review
related:
  - "[[rabbitmq-as-bus]]"
  - "[[message-vs-event-patterns]]"
  - "[[routing-keys-and-contracts]]"
  - "[[hexagonal-architecture]]"
  - "[[module-boundaries]]"
  - "[[api-gateway-pattern]]"
---

# `@nestjs/microservices`: транспорт RMQ

> [!abstract] Кратко
> `@nestjs/microservices` — официальная обёртка NestJS вокруг
> чужих транспортов (TCP, NATS, gRPC, Kafka, **RMQ**). Для
> RabbitMQ внутри пакета используется `amqplib` через
> resilient-reconnect-обёртку `amqp-connection-manager`. С точки
> зрения app-кода это даёт три примитива: `Transport.RMQ` +
> `NestFactory.createMicroservice` на consumer-стороне,
> `ClientProxy` (через `ClientsModule.registerAsync`) на
> producer-стороне и пара декораторов
> `@MessagePattern` / `@EventPattern` (см. их разбор в
> [[message-vs-event-patterns]]). Все три примитива в проекте
> заперты под жёсткое правило: **`@nestjs/microservices` импортируется
> только из `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`**
> — это фиксированная архитектурная граница из ADR-009 / ADR-012 /
> ADR-013, проверяемая `eslint-plugin-boundaries`.

## Проблема, которую решает

`amqplib` — низкоуровневый клиент: `connect`, `createChannel`,
`assertQueue`, `consume(queue, callback, options)`. Если каждый
сервис будет ходить по этому API напрямую, мы получим:

- ручную сборку Observable/Promise семантики поверх callback'ов;
- расхождение в обработке reconnect'а между сервисами;
- handler'ы, размазанные между `if (msg.fields.routingKey === …)`
  и обычными NestJS-роутами;
- невозможность Mock'ать брокер в unit-тестах без подмены
  amqplib.

NestJS-команда инкапсулирует всё это в `@nestjs/microservices`:

- `NestFactory.createMicroservice` поднимает RMQ-consumer,
  который слушает целую очередь и распаковывает
  `pattern` из envelope'а сам;
- `ClientProxy` оборачивает publish в **холодный Observable**, и
  стандартный rxjs `firstValueFrom` превращает его в Promise;
- декораторы `@MessagePattern` / `@EventPattern` отмечают
  методы контроллера как RMQ-handler'ы — те же самые контроллеры,
  что и в HTTP-сценарии, просто с другим источником входа.

Это даёт два следствия:

1. Бизнес-код перестаёт зависеть от `amqplib`. Все импорты
   `@nestjs/microservices` (а через него транзитивно
   `amqplib`/`amqp-connection-manager`) собраны в небольшой
   набор адаптеров.
2. Один и тот же ментальный аппарат («контроллер принимает
   запрос → use-case делает работу → возвращает результат»)
   работает и для HTTP, и для RMQ.

Платой становится зависимость от конкретного API
`@nestjs/microservices` — но эта зависимость осознанная и
заперта в `libs/messaging` + адаптеры (см. [ADR-008](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/008-rabbitmq-via-libs-messaging.md)).

## Концепция

### Две стороны: producer и consumer

В терминах `@nestjs/microservices` каждый процесс — это либо
consumer (получает сообщения из очереди), либо producer
(публикует), либо и то и другое одновременно. В проекте:

| Процесс | Слушает | Публикует |
|---|---|---|
| `api-gateway` | ничего (HTTP-only) | `retail_queue`, `inventory_queue` |
| `retail-microservice` | `retail_queue` | `inventory_queue`, `notification_events` |
| `inventory-microservice` | `inventory_queue` | `notification_events` |
| `notification-microservice` | `notification_events` | ничего |

Consumer-сторона включается одной строкой в `main.ts`:
`NestFactory.createMicroservice(AppModule, { transport, options })`.
Producer-сторона — это `ClientProxy`, который получает app по
DI-токену из `ClientsModule.registerAsync([...])`.

### `ClientProxy` и его cold Observable

Главная странность API, на которую разработчики наступают —
`ClientProxy.send(pattern, payload)` и `.emit(pattern, payload)`
возвращают **rxjs Observable**, причём холодный: пока на него
не подписались, ни одно сообщение не отправлено в брокер.

```typescript
// концептуально
const observable = client.send<TResp, TReq>(pattern, payload);
// → ничего не послано в RMQ

const result = await firstValueFrom(observable);
// → ↑ только тут происходит publish + await reply
```

`firstValueFrom` из rxjs подписывается на Observable, ждёт первое
значение и резолвит Promise. Это **идиоматический мост** между
NestJS-микросервисами и async/await кодом. Без него Observable
останется холодным, и у вас будут странные баги «`emit` вызван,
но в логах брокера ничего нет».

Это правило справедливо и для RPC (`send`), и для событий (`emit`):
`emit` тоже возвращает Observable, и его тоже надо
материализовать, иначе publish никогда не произойдёт.

### Граница: `ClientProxy` живёт только в адаптере

Если разрешить `@Inject(MicroserviceClientTokenEnum.X) private client: ClientProxy`
в любом use-case, то:

- use-case тащит транспортные зависимости (rxjs, Observable);
- unit-тест use-case'а должен Mock'ать `ClientProxy.send`;
- замена RMQ на NATS затронет каждый use-case;
- handler'ы кросс-сервисных flow'ов размазаны между application
  и infrastructure.

Чтобы этого избежать, фиксируется граница из
[ADR-009](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/009-port-adapter-at-the-gateway.md):

> `ClientProxy` from `@nestjs/microservices` is allowed **only**
> inside `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`.

Use-case инжектит **порт** (например, `RETAIL_GATEWAY_PORT`,
`INVENTORY_CONFIRM_GATEWAY`, `ORDER_EVENTS_PUBLISHER`), а в
`*.module.ts` порт связан с `*-rabbitmq.adapter.ts` или
`*-rabbitmq.publisher.ts`-implementor'ом. Это «классический»
hexagonal-арапаптер: интерфейс — в application, реализация — в
infrastructure. См. [[hexagonal-architecture]] и
[[module-boundaries]].

Линт-правило проверяется `eslint-plugin-boundaries` (см.
[ADR-017](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/017-architecture-lint-via-eslint-boundaries.md))
и валит `yarn lint` при любом несанкционированном импорте
`@nestjs/microservices` за пределами адаптерного слоя.

## Применение в проекте

### Consumer: `createMicroservice` в `main.ts`

Все три микросервиса бутстрапятся через
`NestFactory.createMicroservice<MicroserviceOptions>` с
`Transport.RMQ`:

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

`app.listen()` — async-операция, она:

1. Открывает TCP-соединение к RabbitMQ;
2. Заявляет очередь (`assertQueue('inventory_queue', { durable: true })`);
3. Регистрирует consumer'а, который для каждого сообщения смотрит
   `pattern` и зовёт нужный `@MessagePattern` / `@EventPattern`-метод.

Если RabbitMQ недоступен в момент старта, `amqp-connection-manager`
переподключается в фоне; первый `app.listen()` всё равно резолвится
оптимистично. Это сознательный выбор библиотеки — production-сервис
не должен падать просто потому, что брокер ещё не поднялся.

API Gateway отличается — он HTTP-only, поэтому в его `main.ts`
вместо `createMicroservice` стоит обычный
`NestFactory.create(AppModule)`. Producer-сторону он подключает
через `ClientsModule.registerAsync`, см. ниже.

### Producer: `ClientsModule.registerAsync` через `MicroserviceClientConfiguration`

`ClientProxy` нельзя `new`-нуть — его строит Nest по конфигурации.
В проекте конфигурация общая для всех клиентов; класс-обёртка живёт
в `libs/messaging`:

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

Поверх неё — три ClientsModule-обёртки. Вот, например, retail:

```typescript
// libs/messaging/microservice-client-retail.module.ts
@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      new MicroserviceClientConfiguration(
        MicroserviceClientTokenEnum.RETAIL_MICROSERVICE,
        MicroserviceQueueEnum.RETAIL_QUEUE,
      ),
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientRetailModule {}
```

> [GitHub: libs/messaging/microservice-client-retail.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/messaging/microservice-client-retail.module.ts#L1-L24)

Это даёт DI-токен `MicroserviceClientTokenEnum.RETAIL_MICROSERVICE`,
по которому любая часть приложения может попросить `ClientProxy`.
Но «может попросить» ≠ «должна попросить» — см. правило выше.

### Producer: единственный legal-импорт `ClientProxy`

В адаптере gateway'а для retail:

```typescript
// apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts
@Injectable()
export class RetailRabbitmqAdapter implements IRetailGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async createOrder(
    dto: OrderCreateDto,
    correlationId: string,
  ): Promise<OrderCreateResponseDto> {
    return firstValueFrom(
      this.client.send<OrderCreateResponseDto, IOrderCreatePayload>(
        ROUTING_KEYS.RETAIL_ORDER_CREATE,
        { ...dto, correlationId },
      ),
    );
  }
  // confirmOrder, getOrderStatus — то же самое
}
```

> [GitHub: apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts#L1-L53)

Три важных момента в этих 50 строках:

1. **Параметры дженерика `send<TResp, TReq>`**. Первый — тип
   ожидаемого ответа, второй — тип payload'а. `IOrderCreatePayload`
   определён в `libs/contracts` и **общий для двух процессов**:
   gateway шлёт его, retail его принимает. Любая правка формы
   сломает компиляцию **синхронно** на обоих концах — это и есть
   контракт (см. [[routing-keys-and-contracts]]).
2. **`ROUTING_KEYS.RETAIL_ORDER_CREATE` вместо строкового
   литерала**. Адаптер не пишет `'retail.order.create'`
   inline — он использует константу из `libs/messaging`.
3. **`firstValueFrom` оборачивает Observable**. Метод возвращает
   `Promise<OrderCreateResponseDto>`, который use-case уже
   нормально `await`-ит.

### Producer: event-publisher с тем же шаблоном

Для событий API такой же. `OrderRabbitmqPublisher` в retail:

```typescript
// apps/retail-microservice/src/modules/orders/infrastructure/messaging/order-rabbitmq.publisher.ts
@Injectable()
export class OrderRabbitmqPublisher implements IOrderEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
  ) {}

  public async publishOrderCreated(
    event: OrderCreatedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IRetailOrderCreatedEvent = {
      orderId: event.aggregateId,
      customerId: event.customerId,
      status: OrderStatusEnum.PENDING,
      products: event.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
      })),
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    // `ClientProxy.emit()` returns a cold Observable; `firstValueFrom`
    // materializes it and waits for the broker ack so application code can
    // await a plain Promise (see _carryover-07 §5 #3).
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailOrderCreatedEvent>(
        ROUTING_KEYS.RETAIL_ORDER_CREATED,
        wire,
      ),
    );
  }
  // publishOrderConfirmed, publishOrderCancelled — то же самое
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/infrastructure/messaging/order-rabbitmq.publisher.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/infrastructure/messaging/order-rabbitmq.publisher.ts#L1-L52)

Отличия от RPC-адаптера:

- метод адаптера принимает domain-объект (`OrderCreatedEvent` из
  `domain/`) и **сам** мэппит его в wire-формат
  `IRetailOrderCreatedEvent` — wire-контракт лежит в
  `libs/contracts/retail/events/`, domain-событие — в
  `apps/retail-microservice/.../domain/`;
- используется `.emit()` вместо `.send()` — fire-and-forget,
  ответ не ждётся;
- результат всё равно `await`-ится через `firstValueFrom`,
  чтобы дождаться broker-ack'а; иначе use-case завершится до
  фактической отправки.

В `_carryover-07 §5 #3` явно зафиксировано: без `firstValueFrom`
вокруг `.emit()` — publish не происходит, потому что Observable
остаётся холодным. Это вторая по частоте грабля в проекте после
«вы забыли `await` где-то выше в стеке».

### Module-wiring: порт ↔ адаптер связаны DI-токеном

В `*.module.ts` бизнес-модуля собирается hexagonal-конструкция:

```typescript
// apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts
@Module({
  imports: [
    DatabaseModule.forFeature([Customer, Order, OrderProduct, OrderProductStatus, OrderStatus]),
    MicroserviceClientInventoryModule,
    MicroserviceClientNotificationModule,
  ],
  controllers: [OrderController],
  providers: [
    OrderTypeormRepository,
    { provide: ORDER_REPOSITORY, useExisting: OrderTypeormRepository },

    OrderRabbitmqPublisher,
    { provide: ORDER_EVENTS_PUBLISHER, useExisting: OrderRabbitmqPublisher },

    InventoryConfirmRabbitmqAdapter,
    { provide: INVENTORY_CONFIRM_GATEWAY, useExisting: InventoryConfirmRabbitmqAdapter },

    ConfirmOrderUseCase,
    CreateOrderUseCase,
    GetOrderUseCase,
    // ...
  ],
})
export class OrdersModule {}
```

> [GitHub: apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts#L1-L55)

Паттерн `{ provide: SYMBOL, useExisting: Adapter }` означает «возьми
ту же самую instance, что и инжектится по имени класса, и
зарегистрируй её ещё под Symbol-токеном». Use-case инжектит
`ORDER_EVENTS_PUBLISHER`, не зная, что под капотом
`OrderRabbitmqPublisher`. Подробнее этот трюк разобран в
[[mappers-and-repositories]] §«DI-binding в module».

Импорт `MicroserviceClientInventoryModule` /
`MicroserviceClientNotificationModule` приносит сюда
`ClientProxy`-инстансы по DI-токенам
`INVENTORY_MICROSERVICE` / `NOTIFICATION_MICROSERVICE`,
которые потом адаптеры инжектят (`@Inject(...)` в их
конструкторах выше).

### Consumer-handler: `@MessagePattern` / `@EventPattern`

С точки зрения NestJS handler'ы выглядят как обычные методы
обычного контроллера. Эти декораторы — единственное, что
отличает RMQ-handler от HTTP-route:

```typescript
// apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts
@Controller()
export class StockController {
  constructor(
    private readonly getStockUseCase: GetStockUseCase,
    private readonly reserveStockForOrderUseCase: ReserveStockForOrderUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.INVENTORY_PRODUCT_STOCK_GET)
  public async getProductStock(
    @Payload() payload: IProductStockGetPayload,
  ): Promise<ProductStockGetResponseDto> {
    return this.getStockUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM)
  public async handleOrderConfirm(
    @Payload() payload: IProductStockOrderConfirmPayload,
  ): Promise<number[]> {
    return this.reserveStockForOrderUseCase.execute(payload);
  }
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts#L1-L33)

`@MessagePattern(routingKey)` — RPC-handler. Nest распакует
payload, вызовет метод, упакует возвращённое значение и
ответит producer'у в `replyTo`-очередь. Если метод бросит — это
тоже завернётся в RpcException и долетит до producer'а.

`@EventPattern(routingKey)` — то же самое, но без ответа. Любое
исключение в handler'е вызывает либо retry, либо переход в
DLX (зависит от стратегии ack'а; см. ниже).

Полный разбор семантики двух паттернов — в
[[message-vs-event-patterns]].

### Test-bootstrap: `RabbitmqClientFactory`

Иногда нужен `ClientProxy` без Nest-модуля — например, в e2e-test'е,
который сам публикует синтетическое событие, чтобы убедиться,
что consumer его обработал. Для этого случая есть отдельная
фабрика:

```typescript
// libs/messaging/rabbitmq.client.factory.ts
export class RabbitmqClientFactory {
  public static create(configService: ConfigService, queue: MicroserviceQueueEnum): ClientProxy {
    const options: RmqOptions = {
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        queueOptions: { durable: true },
        queue,
      },
    };
    return ClientProxyFactory.create(options);
  }
}
```

> [GitHub: libs/messaging/rabbitmq.client.factory.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/messaging/rabbitmq.client.factory.ts#L1-L21)

В production-коде её **никто не использует** — там идёт через
`MicroserviceClient*Module`. Фабрика — это явный
escape-hatch для тестов: spec-файл создаёт ClientProxy,
публикует, проверяет результат и закрывает proxy в `afterAll`.

## Связанные решения

- [[rabbitmq-as-bus]] — почему транспорт именно RabbitMQ
  (а не Kafka/NATS/HTTP).
- [[message-vs-event-patterns]] — что делать с тем самым
  `@MessagePattern` / `@EventPattern`, когда уже выбрано RMQ.
- [[routing-keys-and-contracts]] — почему адаптеры пишут
  `ROUTING_KEYS.X` вместо литералов, и кто следит за тем,
  чтобы wire-формат не разъехался.
- [[hexagonal-architecture]] — общий шаблон «порт в application,
  адаптер в infrastructure», частным случаем которого здесь
  служит messaging-адаптер.
- [[module-boundaries]] — линт-правило, которое стоит на
  страже «`ClientProxy` только в адаптере».
- [[api-gateway-pattern]] — как один HTTP-вход
  превращается в три producer-вызова через адаптеры.
- [[mappers-and-repositories]] — DI-паттерн
  `{ provide: SYMBOL, useExisting: Class }` подробно разобран
  там.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@nestjs/microservices` | NestJS-пакет, официальная обёртка вокруг чужих транспортов (TCP, RMQ, NATS, gRPC, Kafka). |
| `Transport.RMQ` | Идентификатор RMQ-транспорта в `@nestjs/microservices`. |
| `MicroserviceOptions` | Тип-union опций конкретного транспорта. Здесь — `RmqOptions`. |
| `RmqOptions` | Конфиг RMQ-транспорта: `urls`, `queue`, `queueOptions`, `noAck`, ... |
| `NestFactory.createMicroservice` | Фабрика consumer-приложения NestJS. В отличие от `create`, не открывает HTTP-сервер. |
| `ClientProxy` | Producer-абстракция `@nestjs/microservices`. Имеет два метода: `send` (RPC) и `emit` (event). |
| `ClientsModule.registerAsync` | NestJS-модуль, который регистрирует `ClientProxy` под DI-токеном по асинхронной конфигурации. |
| `ClientProxyFactory.create` | Низкоуровневая фабрика `ClientProxy` без DI; используется в тестах через `RabbitmqClientFactory`. |
| `ClientsProviderAsyncOptions` | Тип-описание одного элемента массива в `registerAsync([…])`. |
| Cold Observable | rxjs-Observable, у которого работа начинается только после `.subscribe()`. `ClientProxy.send` / `.emit` возвращают именно такой. |
| `firstValueFrom` | rxjs-функция; подписывается на Observable, ждёт первое значение, резолвит Promise. Стандартный мост к async/await. |
| `@MessagePattern` | NestJS-декоратор. Помечает метод как RPC-handler для конкретного routing-key. |
| `@EventPattern` | NestJS-декоратор. Помечает метод как event-handler для конкретного routing-key. |
| `@Payload` | NestJS-декоратор. Инжектит body сообщения в параметр handler'а. |
| `amqplib` | Низкоуровневый AMQP-клиент для Node.js. `@nestjs/microservices` использует его транзитивно. |
| `amqp-connection-manager` | Reconnect-обёртка вокруг `amqplib`, переподключается в фоне. |
| `MicroserviceClientTokenEnum` | Enum DI-токенов под `ClientProxy` (`RETAIL_MICROSERVICE`, `INVENTORY_MICROSERVICE`, `NOTIFICATION_MICROSERVICE`). |

> [!faq]- Проверь себя
> 1. Почему `await client.send(...)` не работает «как
>    обычно» — что вернёт `client.send(...)` без обёртки
>    `firstValueFrom`?
> 2. Где в проекте есть единственное место, в которое
>    разрешён `import { ClientProxy } from '@nestjs/microservices'`?
> 3. Чем `MicroserviceClientRetailModule` и `RabbitmqClientFactory`
>    отличаются по назначению — почему нужны обе абстракции?
> 4. Что произойдёт, если в `OrdersModule.providers` оставить
>    только `{ provide: ORDER_EVENTS_PUBLISHER, useClass: OrderRabbitmqPublisher }`
>    и убрать строчку с `OrderRabbitmqPublisher` без `useExisting`?
> 5. Чем `@MessagePattern('retail.order.create')` отличается от
>    декоратора `@Post('order')` в HTTP-контроллере — для NestJS
>    как фреймворка?

## Что почитать дальше

- [NestJS Docs: Microservices Overview](https://docs.nestjs.com/microservices/basics)
  — официальный гид, покрывающий ClientsModule и
  message/event-decorator'ы.
- [NestJS Docs: RabbitMQ](https://docs.nestjs.com/microservices/rabbitmq)
  — RMQ-специфичный раздел, опции `RmqOptions`,
  `socketOptions` и nuance'ы reconnect'а.
- [`amqp-connection-manager` README](https://github.com/jwalton/node-amqp-connection-manager)
  — почему `amqplib` без обёртки не выживает в проде.
