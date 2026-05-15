---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, messaging, contracts, routing-keys]
status: review
related:
  - "[[rabbitmq-as-bus]]"
  - "[[nest-microservices-transport]]"
  - "[[message-vs-event-patterns]]"
  - "[[hexagonal-architecture]]"
  - "[[module-boundaries]]"
  - "[[shared-libs-philosophy]]"
  - "[[trace-log-correlation]]"
---

# Routing keys и контракты сообщений

> [!abstract] Кратко
> Каждое сообщение в шине идентифицируется **routing key** — строкой
> вида `<service>.<aggregate>.<action>` (например,
> `retail.order.confirm`, `inventory.stock.low`). Конвенцию
> фиксирует [ADR-008](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/008-rabbitmq-via-libs-messaging.md);
> до миграции значения были снейк-кейсные
> (`retail_order_create`), task-04 ADR-008 их сменил **в одном
> PR на все четыре app'а**. Чтобы значение строки нельзя было
> ввести с опечаткой, оно хранится **в двух идентичных
> местах**: `ROUTING_KEYS` (frozen `as const`-объект в
> `libs/messaging`) и `MicroserviceMessagePatternEnum`
> (TS-enum в `libs/contracts/microservices`). Что они синхронны
> — гарантирует unit-spec
> `libs/messaging/spec/routing-keys.constants.spec.ts`. Поверх
> routing key payload-форма описывается интерфейсами в
> `libs/contracts/{retail,inventory}/`, все они расширяют
> `ICorrelationPayload` — это создаёт сквозной канал
> `correlationId`, и в [[trace-log-correlation]] его дополняет
> `traceparent`.

## Проблема, которую решает

Когда сервис-A шлёт сообщение в сервис-B, у них общая
поверхность — wire-format. Если эта поверхность **не имеет
названия и формы**, появляются три класса багов:

1. **Опечатка в строке.** `client.send('retail.order.create', ...)`
   на одной стороне и `@MessagePattern('retail.order.greate')` —
   на другой. Компилятор молчит, тесты молчат (если
   не покрыты этот pattern), сообщение тихо уходит в DLX или
   в no-op-обработку.
2. **Расхождение payload'ов.** Сервис-A добавил в payload
   `clientReason: string`, забыл сказать сервису-B. На той
   стороне поле проигнорируется или сломает Joi-валидацию
   спустя пару недель в проде.
3. **Несогласованное переименование.** Кто-то решил переименовать
   `retail.order.create` в `retail.order.placed`. PR прошёл код-ревью
   на одной стороне; на другой осталось старое имя; ни один
   тест не упал, пока flow не сломался на staging'е.

Все три класса решаются одним и тем же способом — **типизированный
контракт в shared-библиотеке**. В монорепе это даже бесплатно: один
импорт из `libs/contracts`, и обе стороны падают одной и той же
ошибкой компиляции при любом расхождении.

ADR-008 + ADR-020 формализуют контракт на трёх уровнях:

- **routing key** — короткая строка, идентифицирует pattern
  целиком, лежит в `ROUTING_KEYS` (+ зеркало в
  `MicroserviceMessagePatternEnum`);
- **payload** — TypeScript-интерфейс, описывающий поля сообщения,
  лежит в `libs/contracts/{retail,inventory}/`;
- **корреляция** — общий «шов» `ICorrelationPayload`, который
  каждый payload расширяет.

## Концепция

### Почему именно `<service>.<aggregate>.<action>`

Конвенция взялась не с потолка. Она:

- **соответствует AMQP-семантике.** Routing key в AMQP — это
  «точечный путь», который topic-exchange матчит по шаблонам:
  `inventory.*.low` (любой второй сегмент), `retail.order.#`
  (всё, что начинается с `retail.order.`). Если сервис вырастает
  и потребуется поделить consumer'ов по части ключа, у нас уже
  правильный формат.
- **читается слева направо: «кто, что, что сделал»**.
  `retail.order.confirm` мгновенно говорит — это вход в retail,
  про order, на confirm.
- **разрешает мульти-словные сегменты через kebab**.
  `product-stock` — два слова одного концепта, разделяются
  дефисом, чтобы не сломать точечную семантику. Так пишется
  `inventory.product-stock.get`, а не
  `inventory.productStock.get` или `inventory.product.stock.get`
  (последнее предполагало бы три уровня иерархии, а у нас
  два).
- **режется на части типизированно**. В TypeScript-enum'е сегмент
  становится частью имени константы:
  `RETAIL_ORDER_CONFIRM = 'retail.order.confirm'`. Имя константы
  и её значение читаются одинаково; никакой ментальной
  трансляции «прочитал `RETAIL_ORDER_CONFIRM` — а ну-ка вспомнил
  значение» не нужно.

Раньше значения были снейк-кейсные (`retail_order_create`).
ADR-008 называет этот формат «не AMQP-идиоматичным» и
переводит в dotted. Wire-формат при этом ломающий, потому что
producer и consumer должны видеть **одно и то же значение**
строки. Допустимо это было только потому, что:

1. Все четыре app'а деплоятся одной PR-pull-секцией; нет
   «gateway уже на dotted, retail ещё на snake».
2. Test-инфраструктура полностью пересоздаётся на каждый прогон
   (`yarn test:infra:reload`), in-flight-сообщений нет.

В большой компании с независимыми релизами такой ломающий
переход потребовал бы переходного периода (publisher шлёт оба
ключа, consumer слушает оба, потом старое выпиливается). У нас
этого периода не было.

### Двойной источник истины — это не баг

В `libs/messaging` и `libs/contracts/microservices` ключи
дублируются. Почему?

- **`libs/contracts/microservices/microservice-message-pattern.enum.ts`**
  — каноничный источник для **транспортных идентификаторов**.
  Тут же лежат `MicroserviceQueueEnum` (имена очередей) и
  `MicroserviceClientTokenEnum` (DI-токены под `ClientProxy`).
  `libs/contracts` — это framework-free wire-контракты; от
  них зависят и producer, и consumer.
- **`libs/messaging/routing-keys.constants.ts`** — то же
  самое, но в форме `as const`-объекта. ADR-008 объясняет:
  TypeScript-enum — это конструкция «уровня типов и значений»,
  у которой есть свои особенности (зарезервированное слово в
  runtime, частичная dead-code-eliminability). Frozen
  `as const`-объект — более идиоматичный паттерн для
  «коллекция читаемых строк», и новые места проекта по
  умолчанию импортируют его. Старые места, которые уже
  используют enum, продолжают компилироваться.

То есть это не дубль ради дубля, а «совместимость + новый стиль».
Сейчас оба тянутся параллельно; со временем enum выпилится, если
все callers'ы переедут на `ROUTING_KEYS`. Спека ниже сделает
любое разъезжание шумным:

```typescript
// libs/messaging/spec/routing-keys.constants.spec.ts
describe('ROUTING_KEYS', () => {
  it('matches MicroserviceMessagePatternEnum values', () => {
    expect(ROUTING_KEYS.RETAIL_ORDER_CREATE).toBe(
      MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE,
    );
    // ... и так далее, для каждой пары
    expect(ROUTING_KEYS.NOTIFICATION_HEALTH_PING).toBe(
      MicroserviceMessagePatternEnum.NOTIFICATION_HEALTH_PING,
    );
  });

  it('uses dotted naming convention', () => {
    for (const value of Object.values(ROUTING_KEYS)) {
      expect(value).toMatch(/^[a-z]+(\.[a-z-]+)+$/);
    }
  });
});
```

> [GitHub: libs/messaging/spec/routing-keys.constants.spec.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/messaging/spec/routing-keys.constants.spec.ts#L1-L46)

Спека делает две вещи:

1. **`expect(ROUTING_KEYS.X).toBe(MicroserviceMessagePatternEnum.X)`**
   — синхронизация. Любая правка в одном месте без правки в
   другом валит `yarn test:unit`.
2. **`expect(value).toMatch(/^[a-z]+(\.[a-z-]+)+$/)`**
   — проверка конвенции. Регэксп требует: первый сегмент
   — только нижний регистр, потом точки и опциональные kebab'ы.
   Это страховка от того, чтобы кто-то по привычке записал
   `Retail.Order.Create` или `retail_order_create`.

### Контракт payload'а — interface в `libs/contracts`

Routing key — это только «название». Сама payload-форма описана
TS-интерфейсом и лежит рядом с domain'ом, к которому относится:

- `libs/contracts/retail/interfaces/` — `IOrderCreatePayload`,
  `IOrderConfirmPayload`, ...
- `libs/contracts/retail/events/` — `IRetailOrderCreatedEvent`,
  `IRetailOrderConfirmedEvent`, `IRetailOrderCancelledEvent`.
- `libs/contracts/inventory/product-stock/` —
  `IProductStockGetPayload`,
  `IProductStockOrderConfirmPayload`.
- `libs/contracts/inventory/events/` —
  `IInventoryStockLowEvent`.

Сам интерфейс — обычный плоский TS-type:

```typescript
// libs/contracts/retail/events/order-created.event.ts
import { ICorrelationPayload } from '../../microservices';
import { OrderStatusEnum } from '../enums';

export interface IOrderCreatedEventProduct {
  productId: number;
  quantity: number;
}

// Wire-format shape for the `retail.order.created` event published by the
// retail microservice after a successful order creation. Framework-free —
// consumers (today: notification-microservice) depend on the interface only.
export interface IRetailOrderCreatedEvent extends ICorrelationPayload {
  orderId: number;
  customerId: number;
  status: OrderStatusEnum;
  products: IOrderCreatedEventProduct[];
  occurredAt: string;
}
```

> [GitHub: libs/contracts/retail/events/order-created.event.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/retail/events/order-created.event.ts#L1-L18)

Нет `@Nestjs/*`-декораторов, нет ссылок на `domain/`. Интерфейс
— framework-free. Это позволяет:

- Импортировать его с обеих сторон шины без втягивания лишнего
  графа зависимостей.
- Делать compile-time контракт-test: если retail-publisher и
  notification-consumer оба `import { IRetailOrderCreatedEvent }`,
  любое расхождение в форме сломает компиляцию **синхронно**
  на обоих концах.

ADR-013 §7 называет это «cross-service contract test is the
TypeScript compile»: отдельной runtime-проверки нет,
TypeScript на двух концах сам её даёт.

## Применение в проекте

### `ROUTING_KEYS` целиком

`libs/messaging/routing-keys.constants.ts` — короткий файл, в
котором собран весь wire-словарь проекта:

```typescript
// libs/messaging/routing-keys.constants.ts
export const ROUTING_KEYS = {
  RETAIL_ORDER_CREATE: 'retail.order.create',
  RETAIL_ORDER_CONFIRM: 'retail.order.confirm',
  RETAIL_ORDER_GET: 'retail.order.get',
  RETAIL_ORDER_CREATED: 'retail.order.created',
  RETAIL_ORDER_CONFIRMED: 'retail.order.confirmed',
  RETAIL_ORDER_CANCELLED: 'retail.order.cancelled',
  INVENTORY_PRODUCT_STOCK_GET: 'inventory.product-stock.get',
  INVENTORY_ORDER_CONFIRM: 'inventory.order.confirm',
  INVENTORY_STOCK_LOW: 'inventory.stock.low',
  NOTIFICATION_HEALTH_PING: 'notification.health.ping',
} as const;

export type RoutingKey = (typeof ROUTING_KEYS)[keyof typeof ROUTING_KEYS];
```

> [GitHub: libs/messaging/routing-keys.constants.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/messaging/routing-keys.constants.ts#L1-L18)

Десять ключей делятся на четыре класса:

| Класс | Примеры | Pattern |
|---|---|---|
| **RPC inbound в микросервис** | `retail.order.create`, `retail.order.confirm`, `retail.order.get`, `inventory.product-stock.get`, `inventory.order.confirm` | `@MessagePattern` + `ClientProxy.send` |
| **Cross-service event publish** | `retail.order.created`, `inventory.stock.low` | `@EventPattern` + `ClientProxy.emit` |
| **Event с зарезервированной surface** | `retail.order.confirmed` (никто не слушает), `retail.order.cancelled` (нет producer'а) | Заготовка под будущее |
| **Health** | `notification.health.ping` | `@MessagePattern` (RPC, RMQ-only health-check) |

Заготовки на `confirmed` / `cancelled` — деталь
[ADR-013](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/013-order-aggregate-and-cross-service-confirm.md#consequences):
publisher уже умеет, consumer'ов сегодня нет, но если завтра
появится аналитика, добавлять имя в `ROUTING_KEYS` уже не
придётся. Это часть «one transport-side change at a time»-философии.

### `MicroserviceMessagePatternEnum` — зеркало

В `libs/contracts/microservices` лежит совпадающий enum:

```typescript
// libs/contracts/microservices/microservice-message-pattern.enum.ts
export enum MicroserviceMessagePatternEnum {
  INVENTORY_PRODUCT_STOCK_GET = 'inventory.product-stock.get',
  INVENTORY_ORDER_CONFIRM = 'inventory.order.confirm',
  INVENTORY_STOCK_LOW = 'inventory.stock.low',
  RETAIL_ORDER_CREATE = 'retail.order.create',
  RETAIL_ORDER_CONFIRM = 'retail.order.confirm',
  RETAIL_ORDER_GET = 'retail.order.get',
  RETAIL_ORDER_CREATED = 'retail.order.created',
  RETAIL_ORDER_CONFIRMED = 'retail.order.confirmed',
  RETAIL_ORDER_CANCELLED = 'retail.order.cancelled',
  NOTIFICATION_HEALTH_PING = 'notification.health.ping',
}
```

> [GitHub: libs/contracts/microservices/microservice-message-pattern.enum.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/microservices/microservice-message-pattern.enum.ts#L1-L17)

В новом коде проекта импортируется `ROUTING_KEYS`, не enum.
Адаптеры (`RetailRabbitmqAdapter`, `InventoryConfirmRabbitmqAdapter`,
`OrderRabbitmqPublisher`, `StockRabbitmqPublisher`) и контроллеры
(`OrderController`, `StockController`) делают
`ROUTING_KEYS.RETAIL_ORDER_CREATE` — никаких inline-литералов в
кодовой базе сегодня нет (это закрепляется ESLint-правилом
`no-magic-strings`-аналогом через `eslint-plugin-boundaries` —
см. [[module-boundaries]]).

### `ICorrelationPayload` — общий шов

В `libs/contracts/microservices/correlation.types.ts` живёт
одно из самых маленьких и одновременно самых важных правил
проекта:

```typescript
// libs/contracts/microservices/correlation.types.ts
export interface ICorrelationPayload {
  correlationId: string;
}
```

> [GitHub: libs/contracts/microservices/correlation.types.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/microservices/correlation.types.ts#L1-L7)

Все wire-payload'ы её расширяют. Примеры:

- `IOrderCreatePayload extends ICorrelationPayload, OrderCreateDto`;
- `IOrderConfirmPayload extends ICorrelationPayload`;
- `IProductStockGetPayload extends ICorrelationPayload`;
- `IProductStockOrderConfirmPayload extends ICorrelationPayload`;
- `IRetailOrderCreatedEvent extends ICorrelationPayload`;
- `IRetailOrderConfirmedEvent extends ICorrelationPayload`;
- `IRetailOrderCancelledEvent extends ICorrelationPayload`;
- `IInventoryStockLowEvent extends ICorrelationPayload`.

Что это даёт:

1. **`correlationId` — обязательное поле payload'а.** TypeScript
   не даст producer'у забыть его. В адаптерах
   (`*-rabbitmq.adapter.ts`, `*-rabbitmq.publisher.ts`) видно,
   как они его прокидывают:

   ```typescript
   return firstValueFrom(
     this.client.send<OrderCreateResponseDto, IOrderCreatePayload>(
       ROUTING_KEYS.RETAIL_ORDER_CREATE,
       { ...dto, correlationId },
     ),
   );
   ```

   `correlationId` приходит сверху — на gateway его сгенерировал
   `CorrelationMiddleware` из `@retail-inventory-system/observability`
   (или взял из заголовка `x-correlation-id`); на retail он же
   приходит в payload'е и передаётся дальше в inventory:

   ```typescript
   confirmedOrderProductIds = await this.inventoryGateway.reserveOrderStock({
     products,
     correlationId,
   });
   ```

2. **Каждая Pino-строка с этим id матчится.** Сервисы пишут
   `this.logger.info({ correlationId, … }, '...')`; в Loki/ELK
   запрос `correlationId="abc-123"` собирает все строки одного
   end-to-end-flow по четырём сервисам.

3. **`correlationId` ≠ `traceparent`.** Это два независимых
   канала. `correlationId` идёт в **payload** и виден человеку
   в логах. `traceparent` (W3C Trace Context) идёт в
   **AMQP message properties** и виден OTel-инструментации;
   span'ы между сервисами связываются именно по нему,
   без касания payload'а. Подробнее — в [[trace-log-correlation]].

   Почему два канала, а не один? Потому что они служат разным
   аудитам. `correlationId` — для людей и для бизнес-логов;
   нет смысла tracer'у генерить «человекочитаемый» id для
   каждого span'а. `traceparent` — для машинных span-чейнов;
   нет смысла отдавать пользователю/логам опаковую
   16-байтную hex-строку.

### Anti-pattern: писать routing-key литералом

В кодовой базе **нет** мест, где строка `'retail.order.create'`
пишется inline. Любое такое место надо заменить на
`ROUTING_KEYS.RETAIL_ORDER_CREATE` и проверить, что:

- значение `ROUTING_KEYS.X` совпадает с тем, что хотел автор;
- enum-зеркало `MicroserviceMessagePatternEnum.X` совпадает
  (если нет — спека ниже сломается).

Если нужного pattern'а ещё нет — это два изменения в двух
файлах, плюс новая строка в spec'е. Это сделано специально:
добавление routing key — это **архитектурное действие**,
которое должно проходить ревью.

### Anti-pattern: добавить поле в payload без обновления контракта

Контракт-test compile-time'овый, но «дописал поле в адаптере»
сломает его только если оба конца импортируют один и тот же
тип. Поэтому обе стороны **обязаны** ходить через
`libs/contracts`. Если кто-то решит выписать собственный
`IOrderCreatePayloadV2` рядом — компилятор не поймает,
консультант поймает на ревью.

### Anti-pattern: положить wire-event в `domain/`

В retail/inventory есть **два** разных типа «event»:

- `OrderCreatedEvent` (extends `DomainEvent<number>` из
  `libs/ddd`) — это **in-process** агрегатное событие,
  имеет class identity, поведение, методы.
- `IRetailOrderCreatedEvent` (plain interface) —
  это **wire-format**, JSON-форма для AMQP.

Объединять их в один класс — соблазн. ADR-011 § 5 объясняет,
почему этого не делают:

> Cross-service wire format must be a plain JSON shape — no
> class identity to serialize, no `@nestjs/*` decorators to drag
> along. The two concerns share a name but not a representation.

Мэппинг domain-event → wire-interface делает адаптер
(`OrderRabbitmqPublisher.publishOrderCreated`):

```typescript
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
```

Это намеренная асимметрия двух «event»-понятий, и она
[[hexagonal-architecture|гексагональна]]: domain — это
объект-в-памяти со своими инвариантами, wire — это JSON через сеть,
у них не должно быть общего class identity.

## Связанные решения

- [[rabbitmq-as-bus]] — общая шина, по которой едут эти ключи.
- [[nest-microservices-transport]] — где `ROUTING_KEYS.X`
  используется внутри `ClientProxy.send` / `.emit`.
- [[message-vs-event-patterns]] — RPC vs event и как
  имена ключей это отражают (`.create` / `.created`,
  `.confirm` / `.confirmed`).
- [[hexagonal-architecture]] — почему wire-event ≠ domain-event,
  и почему мэппер живёт в адаптере.
- [[module-boundaries]] — линт-правила, которые держат
  `@nestjs/microservices` в адаптере, а `libs/contracts` —
  framework-free.
- [[shared-libs-philosophy]] — `libs/contracts` как единый
  источник истины для wire-format'а; `libs/messaging` как
  consumer.
- [[trace-log-correlation]] — как поверх `correlationId`
  работает `traceparent` (через AMQP message properties, не
  payload).

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Routing key | Строковый идентификатор сообщения в AMQP, точечно-сегментированный. В проекте — `<service>.<aggregate>.<action>`. |
| Topic exchange | AMQP-exchange, который матчит routing key по шаблонам с `*` (один сегмент) и `#` (ноль или больше). В проекте сегодня не активен. |
| `ROUTING_KEYS` | Frozen `as const`-объект в `libs/messaging` с routing-key константами. Идиоматичный путь для нового кода. |
| `MicroserviceMessagePatternEnum` | TypeScript-enum в `libs/contracts/microservices` с теми же значениями. Совместимость со старыми callers'ами. |
| Wire format | Внешнее представление сообщения: routing key + JSON-payload. |
| Wire payload | TS-интерфейс из `libs/contracts/{retail,inventory}/`, описывающий поля payload'а. |
| `ICorrelationPayload` | Базовый интерфейс `{ correlationId: string }`, который каждый wire-payload расширяет. |
| `correlationId` | UUID-подобный идентификатор бизнес-flow'а; ставит gateway-middleware, проходит через все сервисы. |
| `traceparent` | Заголовок W3C Trace Context. Передаётся через AMQP message properties, не через payload. |
| Source of truth | Каноничный источник значения. У routing-key'ев — пара `ROUTING_KEYS` + enum, синхронизированная spec'ом. |
| `as const` | TypeScript-конструкция, замораживающая литералы как самые узкие типы. `ROUTING_KEYS.X` имеет тип `'retail.order.create'`, а не `string`. |
| Domain event | In-process событие агрегата (`OrderCreatedEvent`), наследник `DomainEvent<TId>` из `libs/ddd`. |
| Wire event | Plain JSON-форма события для AMQP (`IRetailOrderCreatedEvent`), интерфейс в `libs/contracts/retail/events/`. |
| Compile-time contract | Кросс-сервисная проверка через TypeScript: оба конца импортируют один тип, расхождение валит сборку. |

> [!faq]- Проверь себя
> 1. Почему `inventory.product-stock.get` написан через дефис,
>    а не camelCase или с третьей точкой?
> 2. Что произойдёт, если кто-то поменяет
>    `ROUTING_KEYS.RETAIL_ORDER_CREATE` на
>    `'retail.order.created'`, забыв синхронизировать enum?
>    Какой именно тест сломается?
> 3. Что произойдёт, если payload-интерфейс
>    `IInventoryStockLowEvent` получит новое опциональное поле
>    `severity?: 'low' | 'critical'`, а consumer-сторона его
>    не прочитает?
> 4. Чем `correlationId` отличается от `traceparent` —
>    почему они едут по разным каналам?
> 5. Почему wire-event (`IRetailOrderCreatedEvent`) и
>    domain-event (`OrderCreatedEvent`) — это два разных типа,
>    а не один класс, реализующий interface?

## Что почитать дальше

- [RabbitMQ — Topic Exchange tutorial](https://www.rabbitmq.com/tutorials/tutorial-five-javascript)
  — формат routing-key и правила матчинга `*` / `#`.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
  — спека `traceparent`/`tracestate` для следующего шага в
  [[trace-log-correlation]].
- [Microservices Patterns — «Messaging Style»](https://microservices.io/patterns/communication-style/messaging.html)
  — Chris Richardson о различиях message-style контрактов
  (commands, queries, events).
