---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, application-layer, use-cases, hexagonal]
status: review
related:
  - "[[hexagonal-architecture]]"
  - "[[clean-architecture-layers]]"
  - "[[module-boundaries]]"
  - "[[mappers-and-repositories]]"
  - "[[message-vs-event-patterns]]"
  - "[[routing-keys-and-contracts]]"
  - "[[shared-libs-philosophy]]"
  - "[[dto-by-direction]]"
  - "[[notifier-port-and-adapters]]"
---

# Use-cases вместо «толстых» сервисов

> [!abstract] Кратко
> Каждый write-сценарий в Retail Inventory System — это **один
> класс**: `*.use-case.ts` под `application/use-cases/`. Use-case
> инжектит только **порты** (`@Inject(ORDER_REPOSITORY)`,
> `@Inject(INVENTORY_CONFIRM_GATEWAY)`, `@Inject(NOTIFIER)`), а
> не `Repository<...>`, не `ClientProxy`, не `Cache`. Это —
> прямое следствие [ADR-004](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/004-adopt-hexagonal-architecture-per-service.md)
> и его pattern-to-avoid в
> [`recommendation.md` §5](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L274-L289).
> Антипаттерн, от которого мы ушли, — это «толстый сервис»: один
> класс знает про БД, про брокер, про кэш и про логгер
> одновременно, и решения о доставке/инвалидации/транзакциях
> запутаны в одной 200-строчной функции. Use-case делает то же
> самое, но через ports — domain-логика остаётся тестируемой
> без поднятия инфраструктуры, а добавление трейсинга или замена
> RabbitMQ на Kafka становится contained-изменением в
> `infrastructure/`.

## Проблема, которую решает

До миграции (`docs/baseline/` snapshot, см.
[ADR-018](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/018-nestjs-monorepo-apps-and-libs.md))
каждый микросервис жил по схеме «один класс — одно действие, но
этот класс делает всё»:

```
app/api/order/
  order.controller.ts
  providers/
    order-create.service.ts        // OrderCreateService
    order-confirm.service.ts       // OrderConfirmService
    order-get.service.ts           // OrderGetService
```

Файлы выглядели аккуратно, разбиение по операциям было уже
половиной правильного подхода. Проблема начиналась внутри.
`OrderConfirmService` инжектил:

- `@InjectRepository(Order)` — TypeORM `Repository<Order>`;
- `@Inject(INVENTORY_MICROSERVICE)` — `ClientProxy` для RPC в
  inventory;
- `@Inject(NOTIFICATION_MICROSERVICE)` — `ClientProxy` для emit'а
  событий;
- `PinoLogger` — логгер;
- `Cache` (через `@nestjs/cache-manager`) — кэш-фасад.

То же самое — в `ProductStockOrderConfirmService` на стороне
inventory: `Repository<ProductStock>`, `Cache`, `Logger`,
плюс `ProductStockCommonService` (фасад с cache-aside,
locked-read и ledger-append'ом). Один класс держал и
запись в БД, и SCAN+UNLINK для Redis, и `firstValueFrom` от
`ClientProxy.emit()`, и условную инвалидацию кэша после
коммита.

[`recommendation.md` §5](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L274-L289)
называет это «толстым сервисом» и перечисляет четыре
наблюдаемых симптома:

1. **TypeORM везде.** `Repository<X>` инжектится прямо в
   service-surface — нет места, где можно прогнать service
   против fake-repository. Unit-тесты либо моки на каждый
   вызов, либо вообще пропускают persistence.
2. **`ClientProxy` течёт в business-логику.** Inventory-сервис
   и retail-сервис держат одинаковый `ClientProxy`-шейп; то,
   что они общаются через RabbitMQ — детали транспорта —
   видно прямо в коде domain-логики.
3. **Cross-cutting нечему прицепиться.** Когда придёт
   OpenTelemetry (см. task-10), generalized cache-aside
   (task-11), notification dispatch (task-07) — нет seam'а,
   куда их повесить, кроме как «дописать ещё одну
   зависимость в `OrderConfirmService`».
4. **Использование сервиса = поднять зависимости.** Тест
   `OrderConfirmService` требует поднять `Repository<Order>`,
   замочить два `ClientProxy`, замочить `Cache` — это уже
   integration-тест, а не unit.

ADR-004 описывает это как ситуацию, где «границы между domain,
application и infrastructure существовали только в виде
договорённостей в код-ревью». Use-case — это первая граница,
которая существует **в виде типа**.

## Концепция

### Что такое use-case

Use-case в проекте — это **класс, реализующий ровно один
сценарий бизнес-операции**. Имя — императив в past-perfective:
`CreateOrderUseCase`, `ConfirmOrderUseCase`,
`ReserveStockForOrderUseCase`, `SendOrderNotificationUseCase`.
Файл — `*.use-case.ts` под `application/use-cases/`. Класс
имеет один public-метод `execute(...)`.

Use-case обязан:

- инжектить **только порты** (`@Inject(SYMBOL)`), а не
  концретные адаптеры;
- координировать `domain/`-объекты — создавать,
  валидировать, вызывать их методы;
- возвращать DTO/view-проекцию (см. [[dto-by-direction]]),
  не доменный объект напрямую (исключение —
  internal-only use-case, который вызывает только другой
  use-case).

Use-case не имеет права:

- импортировать `TypeORM` (`Repository<X>`,
  `EntityManager`)¹;
- импортировать `ClientProxy` из `@nestjs/microservices`;
- импортировать `Cache` из `@nestjs/cache-manager`;
- бросать `HttpException` (`recommendation.md` §5: «Throwing
  `HttpException` from `domain/` or `application/`»). Domain
  бросает domain-error; presentation переводит.

¹ Сегодня в проекте есть **один зафиксированный exception** —
`ReserveStockForOrderUseCase` инжектит `EntityManager` через
`@InjectEntityManager()` с inline-комментарием
`AUDIT/ARCH-LINT-EX-01`. Это документировано в
[ADR-017 §6](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/017-architecture-lint-via-eslint-boundaries.md)
и закрывается будущим `ITransactionPort`. См. ниже.

### Use-case как «application service» — но не «домен service»

Терминология DDD различает **application service** и **domain
service**. Use-case — это application service: он не содержит
бизнес-правил, а **оркестрирует** их. Бизнес-правила (порядок
переходов статусов, инварианты «нельзя зарезервировать
больше, чем доступно» и т.д.) живут в `domain/`:

- `Order.applyInventoryConfirmation(confirmedIds)` решает,
  как меняется состояние агрегата.
- `StockItem` constructor enforces `quantity >= 0`,
  `reservedQuantity >= 0`, `reservedQuantity <= quantity`
  (см. [ADR-012](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/012-stock-aggregate-and-port-adapter.md)
  §2).

Use-case вызывает их, проверяет результат и шевелит порты.
Если завтра «при confirm нужно учитывать loyalty-программу
клиента» — это **новое правило в `Order`**, а не новая ветка
в `ConfirmOrderUseCase`. Use-case остаётся пятидесятистрочной
последовательностью: «вызвать gateway, получить агрегат,
применить операцию, сохранить, опубликовать событие».

### Порты — это всё, что выходит наружу

Use-case разговаривает с внешним миром (БД, broker, кэш,
HTTP-клиенты) через **порты**: интерфейсы, объявленные в
`application/ports/` своего модуля. Каждый порт имеет
DI-symbol того же базового имени:

```typescript
export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

export interface IOrderRepositoryPort {
  findById(id: number): Promise<Order | null>;
  // ...
}
```

Symbol — не string, потому что Nest-DI с символами даёт
type-safe injection-point и нулевую вероятность коллизии
имён (string-token может случайно совпасть с другим
string-token'ом в другом модуле). Симметрия с
`USER_REPOSITORY` / `RETAIL_GATEWAY_PORT` / `NOTIFIER` —
одна конвенция через всю кодовую базу.

Adapter (concrete implementation) живёт в
`infrastructure/persistence/`, `infrastructure/messaging/`,
`infrastructure/cache/` своего модуля. Модуль (`*.module.ts`)
выполняет binding:

```typescript
providers: [
  // ...
  { provide: ORDER_REPOSITORY, useClass: OrderTypeormRepository },
  { provide: ORDER_EVENTS_PUBLISHER, useClass: OrderRabbitmqPublisher },
  { provide: INVENTORY_CONFIRM_GATEWAY, useClass: InventoryConfirmRabbitmqAdapter },
],
```

Поменять MySQL на Postgres — это новый `OrderPostgresRepository`
+ одна строка `useClass`. Use-case не меняется. Заменить
RabbitMQ на Kafka — новый `OrderKafkaPublisher` + одна строка.
Это и есть «dependency inversion» из SOLID на практике: dep
указывает **внутрь**, к application/domain, а не наружу.

## Применение в проекте

### До и после: confirm order

Псевдо-форма легаси-`OrderConfirmService` (восстановлена из
[ADR-013](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/013-order-aggregate-and-cross-service-confirm.md)
«Context» и `_carryover-09.md` `docs/architecture-migration-plan/`),
до миграции:

```typescript
// apps/retail-microservice/src/app/api/order/providers/order-confirm.service.ts
@Injectable()
export class OrderConfirmService {
  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderProduct) private readonly productRepo: Repository<OrderProduct>,
    @Inject('INVENTORY_MICROSERVICE') private readonly inventory: ClientProxy,
    @Inject('NOTIFICATION_MICROSERVICE') private readonly notification: ClientProxy,
    private readonly logger: PinoLogger,
  ) {}

  public async confirm(payload: IOrderConfirmPayload) {
    // 1. RPC to inventory
    const confirmed = await firstValueFrom(
      this.inventory.send('inventory.order.confirm', payload)
    );
    // 2. Compute state transitions inline
    // ... 40 lines of inline status manipulation ...
    // 3. Persist via TypeORM
    await this.productRepo.update({...}, {...});
    await this.orderRepo.update({...}, {...});
    // 4. Emit notification event
    this.notification.emit('retail.order.confirmed', {...});
    // 5. Return DTO via second SELECT
    return this.orderRepo.findOne({ where: { id }, relations: [...] });
  }
}
```

Пять обязанностей в одном методе: RPC, state-transition,
запись, event-emit, чтение для ответа. И весь TypeORM
просочился в class-level: моки требуют поднять
`Repository<Order>` и `Repository<OrderProduct>` отдельно.

После миграции — три зависимости и нулевой TypeORM:

```typescript
// apps/retail-microservice/src/modules/orders/application/use-cases/confirm-order.use-case.ts
@Injectable()
export class ConfirmOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly repository: IOrderRepositoryPort,
    @Inject(INVENTORY_CONFIRM_GATEWAY)
    private readonly inventoryGateway: IInventoryConfirmGatewayPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @InjectPinoLogger(ConfirmOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(order: IOrderConfirm): Promise<OrderConfirmResponseDto> {
    const { id, products, correlationId } = order;
    // ...
    const confirmedOrderProductIds = await this.inventoryGateway.reserveOrderStock({
      products,
      correlationId,
    });
    // ...
    const aggregate = await this.repository.findById(id);
    if (!aggregate) {
      throw new Error(`Order #${id} not found after inventory confirmation`);
    }

    const result = aggregate.applyInventoryConfirmation(confirmedOrderProductIds);
    // ...
    await this.repository.confirmLines({
      orderId: id,
      newlyConfirmedProductIds: result.newlyConfirmedProductIds,
      shouldFlipHeaderToConfirmed: result.allProductsConfirmed,
      correlationId,
    });
    // ...
    for (const event of aggregate.pullDomainEvents()) {
      if (event instanceof OrderConfirmedEvent) {
        try {
          await this.publisher.publishOrderConfirmed(event, correlationId);
        } catch (err) {
          this.logger.warn(/* ... */);
        }
      }
    }

    return this.readSnapshot(id);
  }
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/application/use-cases/confirm-order.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/application/use-cases/confirm-order.use-case.ts#L1-L121)

Что изменилось:

1. **State-transition вынесен в агрегат.**
   `aggregate.applyInventoryConfirmation(...)` — это метод
   `domain/order.model.ts`. Use-case **не знает**, как
   именно меняются статусы; знает только, что метод
   возвращает `IOrderConfirmationResult { skipUpdate,
   allProductsConfirmed, newlyConfirmedProductIds }`. Логика
   переходов («если хотя бы один confirmed → header → CONFIRMED»)
   живёт в одном месте — в агрегате, не разбросана по веткам
   use-case'а.
2. **`ClientProxy` спрятан за `IInventoryConfirmGatewayPort`.**
   Юнит-тест use-case'а инжектит in-memory fake этого порта —
   `IInventoryConfirmGatewayPort` это один метод
   `reserveOrderStock({ products, correlationId })`. Спецификация
   `confirm-order.use-case.spec.ts` использует
   `test-doubles.ts`, jest-free in-memory реализации портов
   (см. [ADR-013](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/013-order-aggregate-and-cross-service-confirm.md)
   §8).
3. **TypeORM запрятан за `IOrderRepositoryPort`.**
   `findById`, `confirmLines`, `findOrderResponse` — каждый
   принимает простые типы и возвращает либо domain-агрегат
   `Order`, либо `OrderConfirmResponseDto`. Никаких
   `Repository<...>`, `QueryBuilder`, `EntityManager` в
   use-case'е.
4. **Domain-event'ы публикуются после persist.**
   `pullDomainEvents()` (из `AggregateRoot<TId>` в
   `libs/ddd`) даёт массив событий, накопленных в
   агрегате во время выполнения. Use-case фильтрует
   `OrderConfirmedEvent` и шлёт через
   `IOrderEventsPublisherPort.publishOrderConfirmed`.
   Падение публикатора — `warn`-лог: order уже persisted,
   нет смысла откатывать. Это **post-commit** контракт
   на уровне use-case'а.

### Inventory: тот же шаблон, тот же результат

Симметричный пример из inventory — `ReserveStockForOrderUseCase`:

```typescript
// apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts
@Injectable()
export class ReserveStockForOrderUseCase {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly publisher: IStockEventsPublisherPort,
    @InjectPinoLogger(ReserveStockForOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IProductStockOrderConfirmPayload): Promise<number[]> {
    // ...
    await this.entityManager.transaction(async (entityManager) => {
      const stockMap = await this.repository.lockedTotalsByProduct(
        { productIds, correlationId },
        entityManager,
      );
      // ... build deltas inside the locked transaction ...
      if (items.length > 0) {
        await this.repository.appendDeltas({ items, correlationId }, entityManager);
      }
    });

    // Post-commit: invalidate cache + emit events.
    // ...
    if (items.length > 0) {
      await this.stockCache.invalidate({ items: invalidateItems, correlationId });
      // ... emit StockLowEvent's ...
    }

    return confirmedIds;
  }
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts#L28-L187)

Трёхпортовая инъекция (`STOCK_REPOSITORY`, `STOCK_CACHE`,
`STOCK_EVENTS_PUBLISHER`) — тот же шаблон, что у
`ConfirmOrderUseCase`. Замечательно, что эти три порта в
двух разных микросервисах **выглядят одинаково**: repository
+ events-publisher везде, плюс модуль-специфичный третий
(`INVENTORY_CONFIRM_GATEWAY` в retail, `STOCK_CACHE` в
inventory). Это и есть «канонический per-module template»
из ADR-011: одна и та же структура — три порта, по одному
adapter'у на каждый.

### Что с `EntityManager` в `ReserveStockForOrderUseCase`

Use-case всё-таки инжектит `EntityManager` напрямую — без
порта. Это единственное исключение в проекте, и оно явно
помечено:

```typescript
// TODO(task-14): replace the raw `@nestjs/typeorm` + `EntityManager` seam
// with an `ITransactionPort` so this use case no longer reaches into the
// ORM directly. Tracked in _carryover-12.md as ARCH-LINT-EX-01.
import { InjectEntityManager } from '@nestjs/typeorm'; // eslint-disable-line boundaries/dependencies
```

> [GitHub: apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts#L1-L7)

Причина — операция reserve должна быть **транзакционной**: за
одну `entityManager.transaction(...)` сначала `SELECT ... FOR
UPDATE` (lock-read через `lockedTotalsByProduct`), потом
`INSERT` deltas. Чтобы передать `entityManager` дальше — в
`repository.lockedTotalsByProduct(payload, entityManager)` —
use-case должен где-то его взять. Сегодня берёт у Nest;
завтра возьмёт у `ITransactionPort` (порт с одним методом
`withTransaction<T>(fn: (tx: TransactionToken) => Promise<T>):
Promise<T>`).

[ADR-017](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/017-architecture-lint-via-eslint-boundaries.md)
§6 явно говорит: «closing it requires introducing an
`ITransactionPort` abstraction — left as a follow-up». Это
один из трёх известных open audit-items проекта; см.
[[module-boundaries]] §«Открытые exception'ы». Use-case
архитектурно остаётся «через порты», но имеет один пунктирный
шов до `EntityManager` — и этот шов виден прямо в коде.

### Read-flow: `GetStockUseCase` и skip-cache

Use-case для **чтения** тоже соблюдает port-discipline.
`GetStockUseCase` инжектит `STOCK_REPOSITORY` и `STOCK_CACHE`
— без `EntityManager` в конструкторе, но принимает
`entityManager?: EntityManager` через `IGetStockOptions`:

```typescript
// apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts
public async execute(
  payload: IProductStockGetPayload,
  options: IGetStockOptions = {},
): Promise<ProductStockGetResponseDto> {
  const { entityManager, ignoreCache = false } = options;
  // A read inside a caller-owned transaction can see uncommitted rows;
  // caching that data would corrupt the shared cache for other callers.
  const skipReason = entityManager ? 'entityManager' : ignoreCache ? 'ignoreCache' : null;

  if (skipReason !== null) {
    return this.repository.aggregateForProduct(
      { productId, storageIds, correlationId },
      entityManager,
    );
  }

  const cached = await this.stockCache.get({ productId, storageIds, correlationId });
  if (cached !== undefined) {
    return cached;
  }
  // ... AUDIT-2026-05-08 [CACHE-001] race window ...
  const data = await this.repository.aggregateForProduct({ productId, storageIds, correlationId });
  await this.stockCache.set({ productId, storageIds, data, correlationId });
  return data;
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts#L28-L83)

Два момента:

1. **Use-case остаётся плоским.** Cache-aside-логика — это
   ~10 строк: get-from-cache, if-miss-then-load, populate-cache.
   Сравните с легаси `ProductStockCommonCacheService` + три
   sub-провайдера на ту же работу.
2. **Skip-cache — отдельный legal-bypass.** Если caller передал
   `entityManager`, значит он держит свою транзакцию — read
   может вернуть uncommitted-данные, кэшировать которые
   нельзя. Use-case это **знает** на уровне типа `options`,
   и обходит cache явно. Конвенция, что `@Cacheable`-декоратор
   (см. `libs/cache`) не подходит для read-use-case с
   skip-bypass-веткой, зафиксирована в
   [`_carryover-11.md` §11 #4](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/tasks/_carryover-11.md) —
   декоратор живёт в lib'е, но без consumer'а сегодня.

### Use-case ≠ method on aggregate

Стоит отдельно отметить, **где не должен находиться
use-case**. Use-case — это NOT:

- **Метод агрегата.** `Order.applyInventoryConfirmation(...)`
  не знает, что есть inventory-микросервис и что нужно
  предварительно дёрнуть RPC. Метод агрегата работает с
  уже валидными данными, переданными ему use-case'ом.
- **Метод репозитория.** `IOrderRepositoryPort.confirmLines(...)`
  не знает, что после неё нужно опубликовать
  `retail.order.confirmed`. Репозиторий — только запись.
- **Метод controller'а / consumer'а.** `OrderEventsConsumer`
  делегирует use-case'у без логики. Controller — только
  «принять wire-payload, дёрнуть `execute`, вернуть response».

Это и есть Single Responsibility на уровне модулей: каждый
файл знает про *одну* концерну, а use-case — это место, где
происходит **оркестрация**.

## Связанные решения

- [[hexagonal-architecture]] — порт/адаптер как механика;
  use-case инжектит порты, потому что мы выбрали именно
  такую инверсию зависимостей.
- [[clean-architecture-layers]] — `application/` живёт между
  `domain/` и `infrastructure/`; правило «зависимости
  направлены внутрь» формализовано в
  [`recommendation.md` §3](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L221-L240).
- [[mappers-and-repositories]] — почему `Order` (domain) и
  `OrderEntity` (TypeORM) — две разные вещи, и почему
  use-case всегда видит первое.
- [[dto-by-direction]] — что use-case получает на вход
  (`*.command.ts`, `*.query.ts`) и что отдаёт на выход
  (`*.response.dto.ts`, `*.view.ts`).
- [[notifier-port-and-adapters]] — канонический пример
  outbound-порта на use-case'е (`SendOrderNotificationUseCase`
  инжектит только `NOTIFIER`).
- [[message-vs-event-patterns]],
  [[routing-keys-and-contracts]] — где use-case
  «соприкасается» с messaging-слоем (через события из
  `pullDomainEvents`).
- [[shared-libs-philosophy]] — почему `IRepositoryPort` живёт
  в `libs/ddd`, а доменные модели — в каждом сервисе своём.
- ADR-004 — оригинальное решение про hexagonal-per-service.
- ADR-011 — notification как canonical template для use-case'ов.
- ADR-012, ADR-013 — реализации этого шаблона в inventory и
  retail (со списком трёх портов каждого).
- ADR-017 §6 — единственный задокументированный exception
  (`ARCH-LINT-EX-01`, `EntityManager` в reserve-use-case'е).

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Use-case | Класс одного write/read-сценария; инжектит порты, не адаптеры. |
| Application service | DDD-термин для use-case'а; «оркестратор», не «правило». |
| Domain service | Бизнес-правило без owning-агрегата; живёт в `domain/`, не в `application/`. |
| Port (inbound) | Интерфейс, через который application говорит с инфраструктурой (repo, cache, broker, gateway). |
| Adapter | Concrete-реализация порта; всегда под `infrastructure/<concern>/`. |
| DI symbol | `Symbol('NAME')` — type-safe injection-token; конвенция всего проекта. |
| Fat service (анти-паттерн) | Класс, инжектящий repo + ClientProxy + cache + logger одновременно. |
| Single Responsibility | Принцип «один файл — одна причина измениться»; use-case — это применение SRP к write-операциям. |
| Dependency inversion | High-level (application) не зависит от low-level (infra); оба зависят от абстракции (порт). |
| `execute(...)` | Единственный public-метод use-case'а (по конвенции). |
| `pullDomainEvents()` | Метод `AggregateRoot<TId>`; возвращает domain-events, накопленные на агрегате. |
| `findById` / `confirmLines` / `save` | Типовые методы инбаунд-порта репозитория. |
| `aggregateForProduct` | Доменно-формованный read-метод (возвращает projection DTO, не агрегат). |
| Post-commit | Шаг, выполняемый после успешного commit'а транзакции (cache-invalidate, event-publish). |
| Internal-only use-case | Use-case, доступный только из другого use-case'а (например, `AddStockUseCase`). |
| `ITransactionPort` | Будущий порт для unit-of-work; закрывает `ARCH-LINT-EX-01`. |
| `ARCH-LINT-EX-01` | Задокументированный exception в `ReserveStockForOrderUseCase` (инжектит `EntityManager`). |
| Test-double | In-memory реализация порта для unit-тестов (`test-doubles.ts`). |

> [!faq]- Проверь себя
> 1. Use-case `ConfirmOrderUseCase` инжектит три порта плюс
>    `PinoLogger`. Почему **именно** эти три (`ORDER_REPOSITORY`,
>    `INVENTORY_CONFIRM_GATEWAY`, `ORDER_EVENTS_PUBLISHER`) — а
>    не, скажем, `CACHE_PORT` или `ClientProxy` напрямую?
> 2. Если завтра нужно «при confirm учитывать promo-код клиента»,
>    куда попадает новое правило — в `Order`, в
>    `ConfirmOrderUseCase`, в `OrderTypeormRepository`, или в
>    `OrderController`?
> 3. `aggregate.pullDomainEvents()` возвращает массив. Почему
>    use-case фильтрует `event instanceof OrderConfirmedEvent`,
>    а не публикует всё подряд? Что бы случилось, если бы там
>    оказался `OrderCreatedEvent`?
> 4. Почему `GetStockUseCase` принимает `entityManager` через
>    `options`, а `ReserveStockForOrderUseCase` инжектит его в
>    конструкторе? В чём разница?
> 5. Объясните, почему unit-тест `ConfirmOrderUseCase` не
>    требует RabbitMQ. Какие три фейка нужно построить, и
>    откуда взять их интерфейсы?

## Что почитать дальше

- [ADR-004 в репозитории](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/004-adopt-hexagonal-architecture-per-service.md)
  — оригинальное commitment to per-module hexagonal layout.
- [`recommendation.md` §3 + §5](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L221-L289)
  — boundary rules и patterns to avoid.
- [Vladimir Khorikov, «Application Services vs Domain Services»](https://enterprisecraftsmanship.com/posts/domain-vs-application-services/)
  — каноническое разделение application service / domain
  service, на которое неявно опирается ADR-004.
- [Vaughn Vernon, «Implementing Domain-Driven Design» — Chapter 14 «Application»](https://www.informit.com/store/implementing-domain-driven-design-9780321834577)
  — Vernon формализует «application service» именно как
  оркестратор; в проекте это и есть use-case.
