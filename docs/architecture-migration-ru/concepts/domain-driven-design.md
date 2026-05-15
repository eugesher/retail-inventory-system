---
created: 2026-05-15
updated: 2026-05-15
tags: [retail-inventory-system, concepts, ddd, domain-driven-design]
status: review
related:
  - "[[hexagonal-architecture]]"
  - "[[clean-architecture-layers]]"
  - "[[entity-vs-domain-model]]"
  - "[[mappers-and-repositories]]"
  - "[[notifier-port-and-adapters]]"
---

# Domain-Driven Design — тактические паттерны в проекте

> [!abstract] Кратко
> Domain-Driven Design (DDD) — это набор подходов к моделированию
> бизнес-области в коде. В Retail Inventory System используются
> **тактические** паттерны: `Aggregate`, `Entity`, `Value Object`,
> `Domain Event` и `Repository`. Все примитивы лежат в
> `@retail-inventory-system/ddd` (framework-free) и наследуются
> доменными моделями в `apps/*/src/modules/*/domain/`. **Стратегические**
> паттерны DDD (bounded context, context mapping) применены в
> ограниченной форме: проект — это **четыре** микросервиса, **не**
> произвольное число bounded-контекстов, и каждый микросервис содержит
> ровно один основной BC (`orders`, `stock`, `notifications`).

## Проблема, которую решает

Tactical DDD отвечает на конкретный вопрос: **где живёт инвариант?**
Инвариант — это правило, которое всегда должно выполняться: «заказ
без позиций существовать не может», «зарезервированное количество не
может превышать имеющееся», «статус заказа меняется только PENDING →
CONFIRMED».

Без явной доменной модели инварианты обычно расползаются по слоям:

- часть — в `class-validator`-декораторах на DTO (не валидирует
  бизнес-смысл, только синтаксис);
- часть — в use-case'е (если приехало больше, чем доступно, кинуть
  ошибку);
- часть — в SQL (`CHECK` constraints, триггеры);
- часть — в коде клиента (фронт проверяет, что quantity > 0).

Любая из этих копий может разойтись с остальными. DDD предлагает
другое: **инвариант живёт там же, где живут данные, на которые он
накладывается** — в доменной модели. Конструктор/фабрика не позволит
создать объект, нарушающий правило; метод-команда не позволит
перевести его в невалидное состояние.

В нашем проекте это особенно важно для модуля `orders` (Order +
OrderProduct + OrderStatusVO) и для модуля `stock` (StockItem с
ограничениями на quantity и reservedQuantity).

## Концепция

### Aggregate, Aggregate Root, Entity

**Aggregate** — это группа объектов, которые меняются как единое целое
и подчиняются одному и тому же набору инвариантов. **Aggregate Root**
— единственный объект группы, к которому разрешено обращаться извне
аггрегата. Все остальные объекты — внутренние сущности, доступ к ним
только через корень.

В нашем коде:

- `Order` — aggregate root. Внутри — массив `OrderProduct` (дочерняя
  entity) и value-object'ы `OrderStatusVO` / `OrderProductStatusVO` /
  `CustomerRef`.
- `StockItem` — aggregate root для пары `(productId, storageId)`.
  Внутренней структуры на сегодня нет; aggregate состоит из единственной
  корневой сущности.

Базовый класс `AggregateRoot` живёт в библиотеке `libs/ddd`:

```typescript
// libs/ddd/aggregate-root.base.ts
export abstract class AggregateRoot<TId> extends Entity<TId> {
  private _domainEvents: DomainEvent<TId>[] = [];

  protected addDomainEvent(event: DomainEvent<TId>): void {
    this._domainEvents.push(event);
  }

  public pullDomainEvents(): DomainEvent<TId>[] {
    const events = this._domainEvents;
    this._domainEvents = [];
    return events;
  }

  public get domainEvents(): readonly DomainEvent<TId>[] {
    return this._domainEvents;
  }
}
```

> [GitHub: libs/ddd/aggregate-root.base.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/ddd/aggregate-root.base.ts#L1-L24)

`Entity` — это объект с идентичностью (`id`); два entity равны, если у
них одинаковый id, **независимо** от состояния полей.

```typescript
// libs/ddd/entity.base.ts
export abstract class Entity<TId> {
  protected readonly _id: TId;
  protected constructor(id: TId) { this._id = id; }

  public get id(): TId { return this._id; }

  public equals(other?: Entity<TId>): boolean {
    if (other === undefined || other === null) return false;
    if (other.constructor !== this.constructor) return false;
    return this._id === other._id;
  }
}
```

> [GitHub: libs/ddd/entity.base.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/ddd/entity.base.ts#L1-L21)

### Value Object

**Value Object (VO)** — объект без идентичности. Два VO равны, если
равны их **значения**. VO неизменяемы: если нужно «поменять» что-то
внутри, создаётся новый объект.

```typescript
// libs/ddd/value-object.base.ts
export abstract class ValueObject<TProps extends Record<string, unknown>> {
  protected readonly props: TProps;

  protected constructor(props: TProps) {
    this.props = Object.freeze({ ...props });
  }

  public equals(other?: ValueObject<TProps>): boolean {
    if (other === undefined || other === null) return false;
    if (other.constructor !== this.constructor) return false;
    return JSON.stringify(this.props) === JSON.stringify(other.props);
  }
}
```

> [GitHub: libs/ddd/value-object.base.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/ddd/value-object.base.ts#L1-L16)

`Object.freeze` — единственная гарантия неизменяемости, которую можно
получить в runtime TypeScript. На уровне типов поля помечены
`readonly`, но это не мешает мутировать через `as any`. Заморозка
закрывает эту дыру.

`OrderStatusVO` иллюстрирует «классический» VO — он оборачивает
enum-значение и привешивает к нему предикаты:

```typescript
// apps/retail-microservice/src/modules/orders/domain/order-status.value-object.ts
export class OrderStatusVO extends ValueObject<IOrderStatusVOProps> {
  public static readonly PENDING = new OrderStatusVO({ value: OrderStatusEnum.PENDING });
  public static readonly CONFIRMED = new OrderStatusVO({ value: OrderStatusEnum.CONFIRMED });

  public get value(): OrderStatusEnum { return this.props.value; }
  public isPending(): boolean { return this.props.value === OrderStatusEnum.PENDING; }
  public isConfirmed(): boolean { return this.props.value === OrderStatusEnum.CONFIRMED; }
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/domain/order-status.value-object.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/domain/order-status.value-object.ts#L1-L31)

Что это даёт по сравнению с голым enum'ом? Если статус — это enum,
условие «заказ ещё не подтверждён» приходится писать как `if (order.statusId
=== OrderStatusEnum.PENDING)` везде, где оно нужно, — и таких мест
с десяток в коде use-case'ов и пайпов. С VO это превращается в
`if (order.status.isPending())` — выражение, ближе к языку домена и
устойчивое к расширению enum'а (если завтра добавим `PARTIALLY_CONFIRMED`,
ту же проверку можно будет адаптировать в одной точке).

### Инварианты в конструкторе

Конструктор aggregate root — место, где **отказывают невалидные
состояния**. `StockItem` показывает это явно:

```typescript
// apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts
constructor(props: IStockItemProps) {
  const reservedQuantity = props.reservedQuantity ?? 0;

  if (!Number.isFinite(props.quantity) || props.quantity < 0) {
    throw new Error(`StockItem: quantity must be a non-negative finite number, got ${props.quantity}`);
  }
  if (!Number.isFinite(reservedQuantity) || reservedQuantity < 0) {
    throw new Error(`StockItem: reservedQuantity must be a non-negative finite number, got ${reservedQuantity}`);
  }
  if (reservedQuantity > props.quantity) {
    throw new Error(
      `StockItem: reservedQuantity (${reservedQuantity}) must not exceed quantity (${props.quantity})`,
    );
  }
  // ...
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts#L27-L51)

И в command-методах:

```typescript
public reserve(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`StockItem.reserve: amount must be a positive finite number, got ${amount}`);
  }
  if (amount > this.availableQuantity) {
    throw new Error(
      `StockItem.reserve: requested ${amount} exceeds available ${this.availableQuantity}`,
    );
  }
  this._reservedQuantity += amount;
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts#L65-L75)

Это — **rich model**. Use-case `ReserveStockForOrderUseCase` не знает,
что значит «зарезервировать слишком много». Он вызывает
`stockItem.reserve(qty)`; если правило нарушено, агрегат бросит
исключение, и use-case переводит его в RPC-ошибку. Логика остаётся в
одном месте.

### Фабрики vs reconstitute

У `Order` есть два «способа создания»:

- `Order.create({ customer, lines })` — фабричный метод для нового
  заказа. Проверяет инварианты (непустой список линий, положительные
  quantity), разворачивает каждый `quantity` в N отдельных
  `OrderProduct`-линий (это легаси-инвариант — таблица `order_product`
  не имеет `quantity`).
- `Order.reconstitute(props)` — публичная reconstruction-точка для
  репозитория. Без событий, без проверок (данные уже в БД, значит они
  валидны).

```typescript
// apps/retail-microservice/src/modules/orders/domain/order.model.ts
public static create(props: {
  customer: CustomerRef;
  lines: { productId: number; quantity: number }[];
}): Order {
  if (!props.lines.length) {
    throw new Error('Order.create: cannot create an order with no line items');
  }
  // ...
  return new Order({ id: null, customer, products, status: OrderStatusVO.PENDING });
}

public static reconstitute(props: IOrderProps): Order {
  return new Order(props);
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/domain/order.model.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/domain/order.model.ts#L58-L94)

Различие критично: при reconstruction мы **не** хотим запускать
проверки заново и **не** хотим, чтобы события «происходили» повторно
(заказ был создан вчера; нам не нужно слать `retail.order.created`
сейчас).

### Domain Event

**Domain Event** — факт, который произошёл в домене и о котором другие
части системы могут хотеть узнать. В нашем коде это `OrderCreated`,
`OrderConfirmed`, `OrderCancelled`, `StockReserved`, `StockReleased`,
`StockLow`.

```typescript
// libs/ddd/domain-event.base.ts
export abstract class DomainEvent<TAggregateId = number> {
  public readonly id: string;
  public readonly occurredAt: Date;
  public readonly aggregateId: TAggregateId;

  protected constructor(aggregateId: TAggregateId) {
    this.id = randomUUID();
    this.occurredAt = new Date();
    this.aggregateId = aggregateId;
  }
}
```

> [GitHub: libs/ddd/domain-event.base.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/ddd/domain-event.base.ts#L1-L17)

`OrderConfirmed` накапливается **внутри aggregate'а**: метод
`Order.applyInventoryConfirmation` вызывает `this.addDomainEvent(new
OrderConfirmedEvent(...))`, если все линии подтвердились. Use-case
после успешной записи в БД делает `order.pullDomainEvents()` и
публикует их через `IOrderEventsPublisherPort`.

```typescript
// apps/retail-microservice/src/modules/orders/domain/events/order-confirmed.event.ts
export class OrderConfirmedEvent extends DomainEvent<number> {
  public readonly customerId: number;
  public readonly lines: IOrderConfirmedEventLine[];

  constructor(props: { orderId: number; customerId: number; lines: IOrderConfirmedEventLine[] }) {
    super(props.orderId);
    this.customerId = props.customerId;
    this.lines = props.lines;
  }
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/domain/events/order-confirmed.event.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/domain/events/order-confirmed.event.ts#L1-L20)

Почему **pull**, а не push? Если бы aggregate сразу публиковал событие
в шину, ему пришлось бы знать про RabbitMQ — а это нарушение
framework-free-инварианта. Pull-семантика отделяет «зафиксировать факт»
от «доставить факт»: фиксирует — aggregate, доставляет — adapter в
infrastructure.

В Retail Inventory System события доставляются **после** транзакции БД
— это даёт минимальную, но реальную гарантию: подписчик не увидит
`retail.order.created` для заказа, который не записался. Это
сознательный компромисс: настоящий transactional outbox мы не
поднимали (см. ADR-013).

### Repository

**Repository** в DDD — это объект-«коллекция aggregate-rootов».
Снаружи он выглядит как `Map<Id, Aggregate>` со стороны use-case'а:
`findById`, `save`. Внутри — TypeORM. В нашем коде это
`IOrderRepositoryPort` и его адаптер `OrderTypeormRepository` (см.
[[hexagonal-architecture]] и [[mappers-and-repositories]]).

Базовый интерфейс — обобщённый:

```typescript
// libs/ddd/repository.port.ts
export interface IRepositoryPort<TAggregate extends AggregateRoot<TId>, TId> {
  findById(id: TId): Promise<TAggregate | null>;
  save(aggregate: TAggregate): Promise<void>;
  delete(aggregate: TAggregate): Promise<void>;
}
```

> [GitHub: libs/ddd/repository.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/ddd/repository.port.ts#L1-L10)

Конкретные порты не обязаны его расширять — `IOrderRepositoryPort` им
не расширяется, потому что добавляет несколько специальных методов
(`findConfirmableOrder`, `findOrderResponse`, `confirmLines`),
сформулированных в терминах модуля `orders`. Базовый интерфейс служит
скорее «декларацией намерения»: если репозиторий выглядит как
коллекция aggregate'ов, он должен укладываться в эту форму.

## Где DDD сознательно остановили

DDD-литература (особенно Vaughn Vernon) описывает много паттернов,
которые мы **не применяем** в этом проекте, и это — осознанное
ограничение:

- **Domain services** — не применяются. У нас всё, что хочется
  поставить «между» aggregate'ами, либо вырастает в use-case, либо
  оформляется как фабрика. Когда понадобится — добавим.
- **CQRS** — не применён. Read- и write-стороны идут через один и тот
  же порт. Если асимметрия чтения и записи усилится, это будет
  отдельный ADR (ADR-004 явно оставил CQRS «за скобками»).
- **Event Sourcing** — не применён и не планируется в обозримом
  горизонте. Domain events публикуются как факты для других сервисов,
  а не как способ хранения состояния.
- **Bounded contexts** в строгом смысле — обозначены, но не
  множественны. Каждый из четырёх сервисов имеет ровно один основной
  BC: retail = `orders`, inventory = `stock`, notification =
  `notifications`, gateway = `auth` + два «pass-through»-модуля
  (`retail`, `inventory`) без своего домена. В ADR-004 это
  зафиксировано прямо: «hexagonal applies uniformly even though only
  the first two carry non-trivial domain logic today».
- **Context map** между сервисами — `inventory → retail` мы условно
  относим к Customer/Supplier с явным RPC-контрактом (`inventory.order.confirm`).
  Подробнее в [[microservices-split]].

## Связанные решения

- [[hexagonal-architecture]] — порты и адаптеры как способ выкатить
  богатый домен наружу.
- [[clean-architecture-layers]] — четыре слоя и правило зависимости
  внутрь; `domain/` — внутренний круг.
- [[entity-vs-domain-model]] — почему domain-модель — это не
  TypeORM-`@Entity`, и кто между ними переводит.
- [[mappers-and-repositories]] — `*.mapper.ts` на границе между
  domain-моделью и таблицей.
- [[notifier-port-and-adapters]] — отдельный случай port/adapter:
  outbound delivery нотификаций.

## Глоссарий

| Термин (EN)         | Перевод / пояснение (RU)                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregate           | Аггрегат — группа объектов, меняющихся как одно целое и подчинённых одному набору инвариантов. В нашем коде: `Order` (с дочерними `OrderProduct`), `StockItem`.                                                                  |
| Aggregate Root      | Корень аггрегата — единственный объект, к которому разрешено обращаться извне. `Order` — корень; `OrderProduct` доступен только через массив `order.products`.                                                                   |
| Entity              | Сущность — объект с идентичностью (`id`). Равенство сравнивает id одного и того же подкласса. См. `libs/ddd/entity.base.ts`.                                                                                                     |
| Value Object        | Объект-значение — без идентичности, неизменяемый, равенство по структурному значению. В нашем коде: `OrderStatusVO`, `OrderProductStatusVO`, `CustomerRef`, `Storage`.                                                           |
| Invariant           | Инвариант — правило, нарушение которого делает объект невалидным. В rich model инварианты живут в конструкторе и command-методах aggregate-root'а, а не в use-case'е или DTO.                                                    |
| Rich domain model   | «Богатая» модель домена — модель с поведением. Противоположность — anemic model, где модель — это сумка геттеров/сеттеров, а вся логика в сервисах.                                                                              |
| Domain Event        | Доменное событие — факт, который произошёл в домене (`OrderCreated`, `StockReserved`). Публикуется через шину для других подписчиков. Базовый класс — `DomainEvent` в `libs/ddd`.                                                |
| Pull semantics      | Pull-модель публикации событий: aggregate накапливает события в приватном массиве, репозиторий или use-case вызывает `pullDomainEvents()` после успешной фиксации. Альтернатива — push (aggregate сам публикует), у нас не используется. |
| Repository          | Репозиторий — объект-«коллекция aggregate'ов» с интерфейсом в стиле `findById/save`. Реализация-адаптер в `infrastructure/persistence/`.                                                                                          |
| Reconstitute        | «Восстановление» — фабричный метод для оживления aggregate'а из персистентных данных. Не запускает инвариант-проверки заново и не записывает события.                                                                            |

## Что почитать дальше

- Eric Evans — *Domain-Driven Design: Tackling Complexity in the Heart
  of Software* (Addison-Wesley, 2003). Большая «синяя» книга.
- Vaughn Vernon — *Implementing Domain-Driven Design* (Addison-Wesley,
  2013). Тактические паттерны с примерами на C# и Java.
- Vaughn Vernon — *Domain-Driven Design Distilled* (Addison-Wesley,
  2016). Короткое (≈150 страниц) введение, удобно как первая книга.
- Eric Evans — *DDD Reference* (2015, бесплатный PDF):
  <https://www.domainlanguage.com/ddd/reference/>.

> [!faq]- Проверь себя
>
> 1. Чем `Entity` отличается от `Value Object` в нашем коде? Приведи
>    пример из модуля `orders`.
> 2. Почему `pullDomainEvents()` возвращает массив и очищает его, а
>    не возвращает «текущее» состояние через геттер?
> 3. Зачем `Order` имеет **два** статических конструктора (`create` и
>    `reconstitute`), и в чём принципиальная разница?
> 4. Если завтра понадобится добавить статус `CANCELLED` в `OrderStatusVO`,
>    что придётся изменить, кроме самого enum'а в `@retail-inventory-system/contracts`?
> 5. Почему framework-free? Что сломается, если мы пометим `Order`
>    как `@Entity` из `typeorm`?
