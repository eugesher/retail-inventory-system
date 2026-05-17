---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, application-layer, ports, notification, template]
status: review
related:
  - "[[use-cases-vs-fat-services]]"
  - "[[dto-by-direction]]"
  - "[[hexagonal-architecture]]"
  - "[[clean-architecture-layers]]"
  - "[[module-boundaries]]"
  - "[[shared-libs-philosophy]]"
  - "[[message-vs-event-patterns]]"
  - "[[routing-keys-and-contracts]]"
  - "[[rabbitmq-as-bus]]"
  - "[[mappers-and-repositories]]"
---

# NotifierPort и адаптеры доставки

> [!abstract] Кратко
> `apps/notification-microservice/src/modules/notifications/`
> — это **канонический per-module template** для всех bounded
> context'ов проекта. Внутри: pure-class `domain/Notification`
> (value object), один application-port `INotifierPort` с
> DI-symbol'ом `NOTIFIER`, два use-case'а (по одному на каждый
> consumed event), три заглушки-adapter'а под `infrastructure/
> delivery/` (`LogNotifierAdapter` — default, Email и Webhook —
> TODO-stubs), два RMQ-consumer'а под `infrastructure/consumers/`,
> и тонкий health-controller в `presentation/`. Подмена доставки
> log→email→webhook — это **одна строка** в
> `notifications.module.ts`. Этот шаблон зафиксирован
> [ADR-011](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/011-notifier-port-and-adapters.md);
> inventory'шный `stock` ([ADR-012](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/012-stock-aggregate-and-port-adapter.md))
> и retail'овский `orders` ([ADR-013](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/013-order-aggregate-and-cross-service-confirm.md))
> копируют его форму verbatim.

## Проблема, которую решает

До task-07 (`docs/architecture-migration-plan/tasks/task-07-build-notification-service.md`)
notification-microservice был **заглушкой**: его `app.module.ts`
поднимал `ConfigModule` + `LoggerModule`, `main.ts`
подсоединялся к очереди `notification_events` — и ничего
больше. Ни одного `@EventPattern`-handler'а, ни одного
`*.use-case.ts`, ни одной адаптер-реализации. ADR-011 в
своём «Context» прямо описывает это начальное состояние.

Альтернативный подход — построить notification как **толстый
сервис**:

```typescript
// гипотетический NotifierService — отвергнутый дизайн
@Injectable()
class NotifierService {
  constructor(
    private readonly mailer: MailerService,        // SMTP-клиент
    private readonly http: HttpService,            // axios для webhook'ов
    private readonly logger: PinoLogger,
    @Inject(NOTIFIER_CHANNEL) private readonly channel: NotificationChannelEnum,
  ) {}

  public async send(notification: Notification): Promise<void> {
    switch (this.channel) {
      case NotificationChannelEnum.EMAIL: return this.mailer.send(...);
      case NotificationChannelEnum.WEBHOOK: return this.http.post(...);
      case NotificationChannelEnum.LOG: return this.logger.info(...);
    }
  }
}
```

Это работающий дизайн (`NotifierService` с feature-flag'ом по
channel'у), но он перекладывает **все** зависимости каждого
канала на **каждый** use-case, который этот сервис инжектит.
В тестах `SendOrderNotificationUseCase` придётся замочить и
`MailerService`, и `HttpService`, и `PinoLogger` — даже если
тест проверяет только «вызывается ли send». В bootstrap'е
придётся проинициализировать SMTP и axios, даже если в dev
выбран `LOG`-channel.

ADR-011 §2 объясняет, почему отвергнут именно этот вариант:

> Conflates delivery selection with business logic and forces
> every adapter's dependencies onto the use case. A port +
> multiple adapters keeps the use case free of webhook URLs,
> SMTP creds, and provider SDKs.

Решение — отделить **«что отправить»** (use-case) от
**«как отправить»** (adapter) — это inversion: use-case
зависит от **порта** (интерфейса), а не от конкретики. И раз
notification — это первый микросервис, который мы строим
в per-module-форме (gateway уже сделан в task-05,
inventory/retail ещё в легаси-форме на момент task-07), он
становится **референс-шаблоном** для следующих двух.

## Концепция

### Шаблон per-module hexagonal

ADR-011 §1 фиксирует layout, который потом копируют ADR-012
(inventory) и ADR-013 (retail):

```
modules/<bounded-context>/
  domain/          # value objects, enums, invariants. No `@nestjs/*`.
  application/
    ports/         # порт-интерфейсы + DI-symbols
    use-cases/     # один класс на write/read-сценарий
  infrastructure/
    consumers/     # @EventPattern/@MessagePattern subscribers (RMQ)
    delivery/      # NOTIFIER-adapters (в inventory — persistence/, cache/, messaging/)
    *.module.ts    # bind port symbols → concrete adapter
  presentation/    # RMQ-only here (health); HTTP — для services, которым он нужен
```

Это и есть «canonical per-module template». Слово
«canonical» здесь означает не «обязательный», а «образцовый»:
если новый модуль создаётся в проекте, его форма должна быть
**та же** — три порта, по одному adapter'у на каждый,
DI-symbol'ы под `application/ports/`, binding в
`infrastructure/*.module.ts`.

### `NotifierPort` как outbound abstraction

```typescript
// apps/notification-microservice/src/modules/notifications/application/ports/notifier.port.ts
import { Notification } from '../../domain';

export const NOTIFIER = Symbol('NOTIFIER');

// Outbound delivery port. The concrete adapter (log, email, webhook, …) is
// injected by `notifications.module.ts`. Use cases depend on this symbol —
// never on a specific transport.
export interface INotifierPort {
  send(notification: Notification): Promise<void>;
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/application/ports/notifier.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/application/ports/notifier.port.ts#L1-L10)

Минимальный порт — один метод. Что важно отметить:

1. **Принимает domain-объект**, не DTO. Внутри `Notification`
   (value object из `domain/`) — `recipient`, `subject`,
   `body`, `metadata`, `channel`. Adapter сам решает, какие
   поля ему нужны: log-adapter сериализует всё, email-adapter
   возьмёт `recipient` как адрес и `subject` как тему,
   webhook-adapter может сериализовать весь объект и POST-нуть.
2. **DI-symbol — `Symbol('NOTIFIER')`.** Не string-token,
   чтобы исключить случайное совпадение имён через всю
   кодовую базу. Конвенция совпадает с `RETAIL_GATEWAY_PORT`
   и `USER_REPOSITORY` (см. [[use-cases-vs-fat-services]]).
3. **`Promise<void>`.** Send fire-and-`await`-resolve — нет
   возврата id/ack/recipt; этим занимается каждый adapter
   per-channel.

### `Notification` как value object

Domain-объект сам по себе не Aggregate-Root, а
**ValueObject** (см. [[entity-vs-domain-model]] для разницы):

```typescript
// apps/notification-microservice/src/modules/notifications/domain/notification.model.ts
export class Notification extends ValueObject<INotificationProps> {
  constructor(props: INotificationProps) {
    if (!props.recipient || props.recipient.trim().length === 0) {
      throw new Error('Notification: recipient must be non-empty');
    }
    if (!props.subject || props.subject.trim().length === 0) {
      throw new Error('Notification: subject must be non-empty');
    }
    if (!props.body || props.body.trim().length === 0) {
      throw new Error('Notification: body must be non-empty');
    }
    if (!Object.values(NotificationChannelEnum).includes(props.channel)) {
      throw new Error(`Notification: unknown channel '${String(props.channel)}'`);
    }

    super({ ...props, metadata: { ...props.metadata } });
  }
  // ... getters ...
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/domain/notification.model.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/domain/notification.model.ts#L1-L53)

Constructor enforce'ит инварианты: recipient — не пустой,
subject — не пустой, body — не пустой, channel — известное
значение enum'а. Adapter **не может получить** half-formed
notification: если use-case (или будущий handler) попытается
сконструировать невалидный объект, конструктор бросит
`Error` до того, как notification дойдёт до `port.send(...)`.

`metadata` копируется через spread — `metadata: { ...props.metadata }`
— чтобы не разделять mutable map с caller'ом. ValueObject
из `libs/ddd` хранит props в `readonly`-form через `Object.freeze`
(под капотом базового класса), но defence-in-depth в виде
spread'а закрывает любую возможность shared-mutable-state.

## Применение в проекте

### Use-case: один класс на consumed event

```typescript
// apps/notification-microservice/src/modules/notifications/application/use-cases/send-order-notification.use-case.ts
@Injectable()
export class SendOrderNotificationUseCase {
  constructor(
    @Inject(NOTIFIER)
    private readonly notifier: INotifierPort,
    @InjectPinoLogger(SendOrderNotificationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(event: IRetailOrderCreatedEvent): Promise<void> {
    const notification = new Notification({
      recipient: `customer:${event.customerId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Order ${event.orderId} received`,
      body: `Order ${event.orderId} for customer ${event.customerId} is now ${event.status}. Items: ${event.products.length}.`,
      metadata: {
        orderId: event.orderId,
        customerId: event.customerId,
        status: event.status,
        productCount: event.products.length,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        orderId: event.orderId,
        customerId: event.customerId,
      },
      'Dispatching order-created notification',
    );

    await this.notifier.send(notification);
  }
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/application/use-cases/send-order-notification.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/application/use-cases/send-order-notification.use-case.ts#L1-L44)

Что use-case **не делает**:

- Не знает, какой channel будет использован для доставки. Здесь
  `NotificationChannelEnum.LOG` пробрасывается «для подсказки»,
  но реальный канал определяется тем, какой adapter привязан
  к `NOTIFIER` через DI.
- Не знает, как канал работает. Никаких SMTP-настроек, axios,
  webhook URL'ов.
- Не управляет retries / DLQ / backoff'ом. Adapter может
  реализовать своё (webhook-stub в будущем будет), но
  use-case не заведует этим.

`SendLowStockAlertUseCase` симметричен — другой event,
другой recipient, тот же `NOTIFIER`:

```typescript
// apps/notification-microservice/src/modules/notifications/application/use-cases/send-low-stock-alert.use-case.ts
@Injectable()
export class SendLowStockAlertUseCase {
  constructor(
    @Inject(NOTIFIER)
    private readonly notifier: INotifierPort,
    @InjectPinoLogger(SendLowStockAlertUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(event: IInventoryStockLowEvent): Promise<void> {
    const notification = new Notification({
      recipient: 'ops:inventory',
      channel: NotificationChannelEnum.LOG,
      subject: `Low stock: product ${event.productId} @ ${event.storageId}`,
      body: `Product ${event.productId} in storage '${event.storageId}' has ${event.quantity} units left (threshold ${event.threshold}).`,
      // ...
    });
    // ...
    await this.notifier.send(notification);
  }
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/application/use-cases/send-low-stock-alert.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/application/use-cases/send-low-stock-alert.use-case.ts#L1-L46)

Заметьте: оба use-case'а имеют **одну зависимость, кроме
логгера** — `INotifierPort`. Тесты соответственно требуют
один in-memory `FakeNotifier` (с `sent: Notification[]`-buffer'ом)
и Pino-spy. `test-doubles.ts` рядом со spec'ами реализует
именно это (ADR-013 §8 описывает ту же конвенцию для retail).

### Adapter: дефолтный `LogNotifierAdapter`

```typescript
// apps/notification-microservice/src/modules/notifications/infrastructure/delivery/log.notifier.adapter.ts
@Injectable()
export class LogNotifierAdapter implements INotifierPort {
  constructor(
    @InjectPinoLogger(LogNotifierAdapter.name)
    private readonly logger: PinoLogger,
  ) {}

  public async send(notification: Notification): Promise<void> {
    this.logger.info(
      {
        recipient: notification.recipient,
        channel: notification.channel,
        subject: notification.subject,
        body: notification.body,
        metadata: notification.metadata,
      },
      'Notification dispatched',
    );

    return Promise.resolve();
  }
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/infrastructure/delivery/log.notifier.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/infrastructure/delivery/log.notifier.adapter.ts#L1-L32)

Это default-binding (ADR-011 §3): «log-notifier — единственный
adapter, у которого нет внешних зависимостей и о котором можно
рассуждать в unit-тестах через Pino-spy». E2E smoke-test
проекта (`test/notification.e2e-spec.ts`) публикует синтетический
`retail.order.created` в очередь и ассертит появление Pino-
строки с `orderId` — именно эту строку производит
`LogNotifierAdapter`.

Email и Webhook — это **scaffold'ы** (ADR-011 §3 объясняет
причину):

```typescript
// apps/notification-microservice/src/modules/notifications/infrastructure/delivery/email.notifier.adapter.ts
@Injectable()
export class EmailNotifierAdapter implements INotifierPort {
  public send(notification: Notification): Promise<void> {
    void notification;
    throw new Error('EmailNotifierAdapter: not implemented');
  }
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/infrastructure/delivery/email.notifier.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/infrastructure/delivery/email.notifier.adapter.ts#L1-L16)

Зачем держать «not implemented»-adapter:

- **DI-слот виден в графе.** Любой человек, открывший
  `infrastructure/delivery/`, сразу видит — «есть три
  канала, из них реализован один».
- **`nodemailer` (или другой провайдер) не попадает в
  `package.json` преждевременно.** Добавлять зависимость
  до того, как выбран провайдер — это коммитменти, от
  которого трудно отказаться. Stub-adapter оставляет дверь
  открытой.
- **Рефакторинг шейпа порта остаётся cheap.** Если `INotifierPort`
  завтра расширится (добавится `sendBatch(...)`), TypeScript
  пометит все три adapter'а как «implements broken» — включая
  TODO-stubs, которые тогда обновятся вместе с реализованным.

### Consumer: тонкая трансляция wire → use-case

`@EventPattern`-subscriber'ы живут в `infrastructure/consumers/`
(ADR-011 §4 объясняет, почему именно там, а не в `presentation/`):

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

```typescript
// apps/notification-microservice/src/modules/notifications/infrastructure/consumers/inventory-events.consumer.ts
@Controller()
export class InventoryEventsConsumer {
  constructor(private readonly useCase: SendLowStockAlertUseCase) {}

  @EventPattern(ROUTING_KEYS.INVENTORY_STOCK_LOW)
  public async onStockLow(@Payload() event: IInventoryStockLowEvent): Promise<void> {
    await this.useCase.execute(event);
  }
}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/infrastructure/consumers/inventory-events.consumer.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/infrastructure/consumers/inventory-events.consumer.ts#L1-L17)

Семь полезных строк на consumer. Что **здесь** правильно:

1. **`ROUTING_KEYS.RETAIL_ORDER_CREATED`**, не строковая
   литерала `'retail.order.created'`. Source of truth для
   wire-формата — `libs/messaging`. Drift между сервисами
   ловится lockstep-spec'ом
   `libs/messaging/spec/routing-keys.constants.spec.ts` (см.
   [[routing-keys-and-contracts]]).
2. **Consumer не пишет логику.** Он не строит `Notification`,
   не решает, кто recipient, не вызывает `notifier.send`. Это
   делает use-case.
3. **`@EventPattern`**, не `@MessagePattern`. Это fan-out
   semantics — нет response, нет каллера, ждущего отклика
   (см. [[message-vs-event-patterns]]). Если consumer
   упадёт, RabbitMQ удерживает message и доставит его
   снова — но producer не блокируется.

ADR-011 §4 объясняет, почему consumer'ы живут под
`infrastructure/`, а не `presentation/`:

> RabbitMQ subscribers are thin adapters that translate
> wire-format payloads into use-case invocations, exactly the
> same way that HTTP controllers are presentation-layer
> adapters from URL + JSON body into use-case calls.

То есть: HTTP-controller — это **inbound presentation**;
RMQ-consumer — это **inbound infrastructure**. Оба
адаптируют внешний канал к use-case. Разница в том, что HTTP-
controller является «лицом» сервиса для browser/curl, а
consumer — для broker'а.

### Module wiring: одна строка для смены доставки

```typescript
// apps/notification-microservice/src/modules/notifications/infrastructure/notifications.module.ts
@Module({
  controllers: [HealthController, OrderEventsConsumer, InventoryEventsConsumer],
  providers: [
    SendOrderNotificationUseCase,
    SendLowStockAlertUseCase,
    LogNotifierAdapter,
    { provide: NOTIFIER, useExisting: LogNotifierAdapter },
  ],
})
export class NotificationsModule {}
```

> [GitHub: apps/notification-microservice/src/modules/notifications/infrastructure/notifications.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/infrastructure/notifications.module.ts#L1-L22)

Здесь происходит всё нужное wiring:

- **`controllers: [...]`** — `HealthController` (presentation,
  обслуживает `notification.health.ping` RPC) +
  `OrderEventsConsumer` + `InventoryEventsConsumer`.
  Consumer'ы тоже формально `@Controller()`-классы (Nest так
  устроен), но семантически они в `infrastructure/`. Каталог
  файла фиксирует слой, а не Nest-метаданные.
- **`providers: [...]`** — два use-case'а, один adapter (Log),
  и **bind**: `{ provide: NOTIFIER, useExisting: LogNotifierAdapter }`.

`useExisting` (не `useClass`) — субтлети. `useExisting`
говорит: «когда кто-то запросит `NOTIFIER`, верни тот же
самый instance, который уже зарегистрирован под классом
`LogNotifierAdapter`». То есть в DI-graph'е лежит **один**
синглтон, а `NOTIFIER` — alias на него. С `useClass` Nest
создал бы второй instance.

**Переключить доставку на webhook** — это литерально:

```typescript
providers: [
  // ...
  WebhookNotifierAdapter,
  { provide: NOTIFIER, useExisting: WebhookNotifierAdapter },
],
```

(плюс зарегистрировать `WebhookNotifierAdapter` в providers
и реализовать `send(...)`). Use-case'ы не меняются. Consumer'ы
не меняются. Domain не меняется. Это и есть ADR-011 §2:
«swapping log → email → webhook is a one-line `useClass` change».

### Presentation: RMQ-only health

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

> [GitHub: apps/notification-microservice/src/modules/notifications/presentation/health.controller.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/notification-microservice/src/modules/notifications/presentation/health.controller.ts#L1-L21)

Notification microservice — **RMQ-only**: нет HTTP-сервера, нет
порта в Docker. Health ходит через тот же транспорт, что и
event'ы (ADR-011 §6). Aргумент против второго listener'а
прямой: «smaller deployment surface and matches the service's
role (it has no client requests — only broker events)».

### Inventory и retail повторяют форму

ADR-012 (inventory `stock` module) и ADR-013 (retail `orders`
module) повторяют ту же шаблонную форму, отличается **только
семантика портов**.

**Inventory `stock`** — три порта:

| Port | DI symbol | Adapter |
|------|-----------|---------|
| `IStockRepositoryPort` | `STOCK_REPOSITORY` | `StockTypeormRepository` |
| `IStockCachePort` | `STOCK_CACHE` | `StockCache` (тонкий wrap над `CACHE_PORT`) |
| `IStockEventsPublisherPort` | `STOCK_EVENTS_PUBLISHER` | `StockRabbitmqPublisher` |

> Анкоры — см.
> [GitHub: apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts#L10-L54)
> и
> [GitHub: stock-events.publisher.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts#L1-L12).

**Retail `orders`** — три порта:

| Port | DI symbol | Adapter |
|------|-----------|---------|
| `IOrderRepositoryPort` | `ORDER_REPOSITORY` | `OrderTypeormRepository` |
| `IOrderEventsPublisherPort` | `ORDER_EVENTS_PUBLISHER` | `OrderRabbitmqPublisher` |
| `IInventoryConfirmGatewayPort` | `INVENTORY_CONFIRM_GATEWAY` | `InventoryConfirmRabbitmqAdapter` |

> Анкор —
> [GitHub: apps/retail-microservice/src/modules/orders/application/ports/inventory-confirm.gateway.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/application/ports/inventory-confirm.gateway.port.ts#L1-L19).

Шаблон один и тот же: **три порта, по одному adapter'у каждый,
DI-symbol через `Symbol('...')`, binding в `*.module.ts`**.
Каждый сервис выбирает третий порт под свою задачу:

- Notification — outbound delivery → `INotifierPort`.
- Inventory — cache adapter → `IStockCachePort`.
- Retail — cross-service RPC gateway → `IInventoryConfirmGatewayPort`.

Это и означает «canonical template»: каркас одинаковый,
наполнение модульное. Когда появится четвёртый bounded
context, его авторам не придётся вспоминать архитектурные
решения — структура уже задана.

### Что `INotifierPort` НЕ делает

- **Не группирует, не batch'ит, не агрегирует.** Один call
  на `send` — одна доставка (или попытка). Если завтра
  понадобится batching, оно появится либо как новый метод
  на порте (`sendBatch(...)`), либо как отдельный adapter
  (`BatchingNotifierAdapter` decorator pattern над концепт-
  adapter'ом).
- **Не делает retry/backoff.** Adapter решает сам. Сегодня
  `LogNotifierAdapter` — fire-and-forget; в будущем
  `EmailNotifierAdapter` может реализовывать retry-with-
  jitter, но это будет деталью adapter'а, не порта.
- **Не отвечает за idempotency.** Если consumer получил
  event дважды (RabbitMQ at-least-once), use-case вызовется
  дважды и notification отправится дважды. Решать дедуп —
  задача либо broker'а (uniq-jti), либо самого канала
  доставки (email-провайдер с dedup-key'ом). На уровне
  порта эта проблема не существует.
- **Не сообщает результат caller'у.** `Promise<void>` —
  «отправилось или брошено exception». Идентификатор
  доставленного письма / webhook-response-status'а живут
  только в логах adapter'а.

## Связанные решения

- [[use-cases-vs-fat-services]] — use-case инжектит порт,
  не adapter. Этот guide — концепт «port»; тот — «use-case»
  как форма.
- [[dto-by-direction]] — `IRetailOrderCreatedEvent` и
  `IInventoryStockLowEvent` — wire-формат event'ов
  (шестой суффикс).
- [[hexagonal-architecture]] — почему inversion of control:
  application зависит от абстракции, infrastructure её
  реализует.
- [[clean-architecture-layers]] — где живут domain, application,
  infrastructure, presentation в файловой системе.
- [[module-boundaries]] — почему RMQ-consumer живёт в
  `infrastructure/`, а HTTP-controller — в `presentation/`.
- [[message-vs-event-patterns]] — `@MessagePattern` (RPC) vs
  `@EventPattern` (events); consumer'ы notification —
  `@EventPattern`.
- [[routing-keys-and-contracts]] — почему
  `ROUTING_KEYS.RETAIL_ORDER_CREATED`, а не string-литерала;
  lockstep-spec, гарантирующий синхронизацию с
  `MicroserviceMessagePatternEnum`.
- [[rabbitmq-as-bus]] — почему RMQ, а не gRPC/Kafka/HTTP.
- [[shared-libs-philosophy]] — `libs/contracts` framework-free;
  events живут именно там.
- [[mappers-and-repositories]] — `IStockRepositoryPort` /
  `IOrderRepositoryPort` следуют той же port/adapter-формуле.
- ADR-011 — оригинальное решение, в котором этот шаблон и
  фиксируется.
- ADR-012 / ADR-013 — копирование шаблона в inventory и
  retail.
- ADR-008 — wire-формат routing-key'ов
  (`<service>.<aggregate>.<action>`).

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Per-module template | Канонический layout: `domain/`, `application/{ports,use-cases}/`, `infrastructure/{consumers,delivery,...}/`, `presentation/`. |
| Bounded context | DDD-термин для модуля; в проекте — `notifications`, `stock`, `orders`, `auth`. |
| `INotifierPort` | Outbound port для доставки notification; `send(Notification): Promise<void>`. |
| `NOTIFIER` | DI-symbol для `INotifierPort`; bind делает `notifications.module.ts`. |
| `Notification` | Value-object из `domain/`; enforce'ит invariants в конструкторе. |
| ValueObject | DDD-термин: равенство по содержанию, не по identity; нет mutable state. |
| AggregateRoot | DDD-термин: единичная transactional unit с identity и lifecycle. `Notification` — НЕ aggregate. |
| `LogNotifierAdapter` | Default-binding для `NOTIFIER`; пишет в Pino. |
| `EmailNotifierAdapter` | TODO-scaffold; bросает `not implemented`. |
| `WebhookNotifierAdapter` | TODO-scaffold; бросает `not implemented`. |
| `useExisting` | Nest-DI: alias на уже зарегистрированный provider; делит singleton. |
| `useClass` | Nest-DI: создаёт новый instance под токеном; обычно создаёт второй экземпляр. |
| `@EventPattern` | Nest-microservices decorator: fan-out semantics, нет response. |
| `@MessagePattern` | Nest-microservices decorator: RPC, типизированный response. |
| `ROUTING_KEYS.RETAIL_ORDER_CREATED` | Константа из `libs/messaging`; одна из 9 routing key'ов проекта. |
| `IRetailOrderCreatedEvent` | Wire-формат события `retail.order.created`; plain TS-interface. |
| `IInventoryStockLowEvent` | Wire-формат события `inventory.stock.low`. |
| `notification_events` | RabbitMQ-очередь, на которую notification-сервис подписан. |
| `NotificationChannelEnum` | `'log' \| 'email' \| 'webhook'` — поле в `Notification`; **подсказка**, не выбор adapter'а. |
| RMQ-only | Сервис без HTTP-listener'а; health через тот же `@MessagePattern`. |
| Fan-out | Pub-sub-semantics: один publish, N subscriber'ов получают каждый свою копию. |
| At-least-once | Гарантия RabbitMQ: message доставлен хотя бы раз; consumer должен переживать дубли. |
| `INotificationHealthResponse` | Shape ответа health-ping; `{ status: 'ok', service: 'notification-microservice' }`. |

> [!faq]- Проверь себя
> 1. `notifications.module.ts` использует `useExisting:
>    LogNotifierAdapter`, а не `useClass: LogNotifierAdapter`.
>    Что бы изменилось, если бы стояло `useClass`?
> 2. `Notification.channel` хранит `NotificationChannelEnum.LOG`
>    в use-case'е, который шлёт через `NOTIFIER`. А реально
>    привязан `LogNotifierAdapter`. Что бы случилось, если бы
>    в use-case'е стояло `NotificationChannelEnum.EMAIL`, а
>    bind остался прежним?
> 3. `OrderEventsConsumer` и `InventoryEventsConsumer` оба
>    лежат в `infrastructure/consumers/`, а не в
>    `presentation/`. Назовите две причины, по которым это
>    правильно (ссылка на ADR-011 §4 поможет).
> 4. `Email`- и `Webhook`-adapter'ы бросают
>    `not implemented`. Зачем они вообще существуют в
>    коде? Почему их не убрать?
> 5. ADR-011 §1 называет notification «canonical per-module
>    template». Какие три DI-symbol'а несут эту форму в
>    inventory? Какие — в retail? Какой из этих трёх в
>    каждом сервисе «модуль-специфичный» (не повторяется
>    через сервисы)?

## Что почитать дальше

- [ADR-011 в репозитории](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/011-notifier-port-and-adapters.md)
  — оригинальное решение, включая список rejected
  alternatives.
- [ADR-012](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/012-stock-aggregate-and-port-adapter.md)
  и
  [ADR-013](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/013-order-aggregate-and-cross-service-confirm.md)
  — копии шаблона в inventory и retail.
- [Alistair Cockburn, «Hexagonal Architecture»](https://alistair.cockburn.us/hexagonal-architecture/)
  — каноническая статья 2005 года; port/adapter в
  оригинальной форме.
- [Vaughn Vernon, «Implementing DDD» Ch. 4 «Architecture»](https://www.informit.com/store/implementing-domain-driven-design-9780321834577)
  — глава, где Vernon уравнивает hexagonal, onion и clean
  architecture как варианты одной идеи.
- [NestJS Microservices docs — Custom Transporters](https://docs.nestjs.com/microservices/custom-transport)
  — для понимания, почему `@EventPattern` и
  `@MessagePattern` — semantically разные.
