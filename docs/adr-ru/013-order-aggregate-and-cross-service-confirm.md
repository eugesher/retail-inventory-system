# ADR-013: Агрегат order и межсервисный поток подтверждения

- **Date**: 2026-05-14
- **Status**: Принято

---

## Контекст

До task-09 retail-микросервис был на legacy-плоской компоновке:

- `apps/retail-microservice/src/app/api/order/`
  - `order.controller.ts` — обработчики `@MessagePattern` для `RETAIL_ORDER_CREATE`, `RETAIL_ORDER_CONFIRM`, `RETAIL_ORDER_GET`.
  - `providers/order-{create,confirm,get}.service.ts` — один сервис на RPC.
  - `pipes/order-{create,confirm}.pipe.ts` — pre-RPC-валидация/загрузка.
  - `domain/order-confirm.domain.ts` — pure-class state-transition computer, решавший «skipUpdate / someProductsConfirmed / allProductsConfirmed» для пути подтверждения.
- `apps/retail-microservice/src/app/common/entities/` — TypeORM-сущности `Customer`, `Order`, `OrderProduct`, `OrderStatus`, `OrderProductStatus`.

ADR-004 объявил гексагональную архитектуру по сервисам целевой
компоновкой; ADR-011 избрал notification-микросервис каноническим
эталонным шаблоном модуля; ADR-012 перевёл inventory в ту же форму.
Retail — последний сервис в проходе по модулям. Единственный
ограниченный контекст сегодня — `orders`. Межсервисный поток
подтверждения (retail → inventory) — заголовочное сквозное
взаимодействие миграции, поэтому это ADR также формализует шаблон
gateway-port, позволяющий use case мокать сторону inventory в
юнит-тестах.

В retail нет модуля `products` — остатками товара владеет inventory;
роль retail — жизненный цикл заказа. Retail-side-агрегат товара,
если будет введён позже, становится своим ADR в то время.

## Решение

### 1. Один ограниченный контекст `orders`

**Выбрано.** Новый модуль живёт в
`apps/retail-microservice/src/modules/orders/`. Имя следует доменному
агрегату (`Order`). Другие сущности, присутствующие сегодня в схеме
retail (`customer`, справочные таблицы `order_status` /
`order_product_status`) не заслуживают сегодня собственных ограниченных
контекстов — таблица `customer` — это read-only-seed-данные, а
справочные таблицы — презентационные.

### 2. Доменный слой

- `Order` расширяет `AggregateRoot<number | null>` из
  `@retail-inventory-system/ddd`. Параметризация `number | null`
  отражает переходное (pre-persistence) состояние агрегата,
  построенного `Order.create({...})`; как только typeorm-репозиторий
  присваивает id, восстановленный агрегат несёт сохранённый id.
- Инварианты, обеспечиваемые на агрегате:
  - массив line items непустой (пустой заказ не может существовать).
  - `applyInventoryConfirmation()` отклоняется, когда статус
    заголовка уже `CONFIRMED`.
  - статусы line-item переходят только `PENDING → CONFIRMED`.
- `OrderProduct` — дочерняя сущность (расширяет `Entity<number | null>`)
  — не отдельный агрегат. Агрегат Order владеет жизненным циклом
  своих линий.
- `CustomerRef` — это `ValueObject<{ id }>`, на который ссылается
  Order. Retail не поддерживает свой агрегат Customer; продвижение
  legacy-сущности `Customer` до VO внутри агрегата Order избегает
  ложной кросс-агрегатной ссылки.
- `OrderStatusVO` / `OrderProductStatusVO` — это VO, оборачивающие
  существующие `OrderStatusEnum` / `OrderProductStatusEnum` из
  `@retail-inventory-system/contracts`. Предикаты переходов
  (`isPending` / `isConfirmed`) живут на типе, а не разбросаны по
  use cases.
- Три in-process-доменных события расширяют `DomainEvent<number>`:
  `OrderCreatedEvent`, `OrderConfirmedEvent`, `OrderCancelledEvent`.

Legacy state-transition computer `OrderConfirmDomain` сворачивается в
`Order.applyInventoryConfirmation(...)` — он возвращает
`IOrderConfirmationResult`, несущий те же три флага
(`someProductsConfirmed / allProductsConfirmed / skipUpdate`) плюс
вновь подтверждённые id линий, которые нужны адаптеру персистентности.

### 3. Три прикладных порта, три конкретных адаптера

- `IOrderRepositoryPort` (DI-символ `ORDER_REPOSITORY`) — входящая
  персистентность. Методы: `findById`, `findHeaderById`,
  `findOrderResponse` (полный JOIN'нутый
  `OrderConfirmResponseDto`), `save`, `confirmLines` (транзакционное
  обновление статуса линий + заголовка). Адаптер:
  `OrderTypeormRepository`.
- `IOrderEventsPublisherPort` (DI-символ `ORDER_EVENTS_PUBLISHER`) —
  исходящая эмиссия событий. Адаптер: `OrderRabbitmqPublisher`,
  оборачивающий `ClientProxy.emit()` и материализацию
  `firstValueFrom`, отмеченную в `_carryover-07 §5 #3`, так что
  прикладной код ожидает обычный Promise. Нацелен на
  `NOTIFICATION_MICROSERVICE` ClientProxy из
  `MicroserviceClientNotificationModule` (добавлен в task-08 для
  потока inventory `stock.low`).
- `IInventoryConfirmGatewayPort` (DI-символ
  `INVENTORY_CONFIRM_GATEWAY`) — исходящий кросс-сервисный вызов к
  обработчику `inventory.order.confirm` inventory-микросервиса.
  Адаптер: `InventoryConfirmRabbitmqAdapter`, оборачивающий
  `ClientProxy.send()` с wire-контрактом `IProductStockOrderConfirmPayload`
  из `@retail-inventory-system/contracts/inventory`.

Третий порт — заголовочное дополнение: `ConfirmOrderUseCase` инжектит
`INVENTORY_CONFIRM_GATEWAY` вместо сырого `ClientProxy`, что
позволяет спеку прорабатывать ветви «stock-confirmed /
stock-insufficient / timeout» без загрузки RabbitMQ.

### 4. Use cases отражают legacy-файлы `*.service.ts`

| Legacy-класс | Новый use case |
|---|---|
| `OrderCreateService` | `CreateOrderUseCase` |
| `OrderConfirmService` | `ConfirmOrderUseCase` |
| `OrderGetService` | `GetOrderUseCase` |

- `CreateOrderUseCase` сохраняет агрегат, затем публикует
  `retail.order.created` после сохранения. Сбои публикации
  логируются warn'ом, но никогда не поднимаются — заказ уже
  сохранён, а fan-out уведомлений — best-effort-шаг после коммита.
- `ConfirmOrderUseCase` сначала вызывает `INVENTORY_CONFIRM_GATEWAY`,
  затем извлекает агрегат, вызывает
  `applyInventoryConfirmation(...)` и управляет адаптером
  персистентности через `confirmLines(...)`. Если агрегат переключился
  на `CONFIRMED`, записанное `OrderConfirmedEvent` сливается через
  `pullDomainEvents()` и публикуется; иначе событие не срабатывает.
- `GetOrderUseCase.findHeaderById(id)` возвращает только статус
  заголовка заказа — `OrderConfirmPipe` API gateway нужно только это,
  чтобы коротко замкнуть non-PENDING-подтверждение с 400. Wire-payload
  остаётся маленьким.

`cancel-order.use-case.ts` сегодня **не** добавлен — legacy-сервис
не экспонировал поток отмены, и сегодня нет потребителя
`retail.order.cancelled`. Метод `cancel()` агрегата и поверхность
порта-публикатора существуют, чтобы будущий поток отмены
подключился без перестройки модуля.

### 5. События пути создания конструируются use case

**Выбрано.** `Order.create({...})` не записывает событие
`OrderCreated` из фабрики. Use case создания конструирует событие
после round-trip репозитория, который присваивает сохранённый id,
затем публикует его.

Обоснование: агрегат не может изготовить свой id, и placeholder
(`orderId: 0`), уплывающий к подписчикам, хуже, чем позволить use
case сформировать событие с реальным id. Путь подтверждения
отличается — `applyInventoryConfirmation(...)` всегда выполняется
против уже сохранённого агрегата, поэтому `OrderConfirmedEvent`
записывается внутри агрегата с реальным id.

Это намеренная асимметрия между двумя потоками. ADR-012 §6
задокументировал тот же компромисс для `stock.low` (эмитируется из
use case, а не из агрегата). Будущие эволюции (transactional outbox)
могут поднять оба пути в унифицированный шаблон.

### 6. Wire-формат контрактов: события живут в `libs/contracts/retail/events/`

`IRetailOrderCreatedEvent` уже был на месте с task-07. Task-09
добавляет:

- `IRetailOrderConfirmedEvent` — публикуется, когда Order
  переключается на `CONFIRMED`. Зарезервировано для будущих
  кросс-сервисных потребителей; подписчика сегодня нет.
- `IRetailOrderCancelledEvent` — зарезервировано для будущего потока
  отмены. Ни продюсера, ни потребителя сегодня.

`ROUTING_KEYS` в `libs/messaging/routing-keys.constants.ts` получает
`RETAIL_ORDER_CONFIRMED` и `RETAIL_ORDER_CANCELLED` для соответствия;
`MicroserviceMessagePatternEnum` в `libs/contracts/microservices/`
синхронизируется, как требуется `routing-keys.constants.spec.ts`.

### 7. Контрактный тест между сервисами — это TypeScript-компиляция

И retail-side-адаптер (`InventoryConfirmRabbitmqAdapter`), и
inventory-side-обработчик (`StockController.handleOrderConfirm`)
импортируют `IProductStockOrderConfirmPayload` из
`@retail-inventory-system/contracts`. Любой дрейф в форме payload
проваливает компиляцию на обоих концах одновременно. Carryover
фиксирует это явно, чтобы рецензенты знали, что отсутствие runtime-
контрактного теста намеренно.

### 8. Компоновка тестов следует структуре модуля inventory

- `domain/spec/` — `order.model.spec.ts` (мигрирован из legacy
  `order-confirm.domain.spec.ts`, утверждения сохранены дословно
  против нового возвращаемого типа `applyInventoryConfirmation`) + новый
  `order-create.model.spec.ts`, покрывающий инварианты фабрики.
- `application/use-cases/spec/` — один спек на use case плюс
  `test-doubles.ts`, несущий in-memory-реализации
  `IOrderRepositoryPort`, `IInventoryConfirmGatewayPort` и
  `IOrderEventsPublisherPort`. `test-doubles.ts` jest-free, чтобы
  продакшен-сборка осталась чистой (`tsconfig.app.json` исключает
  только `*.spec.ts` — см. `_carryover-08 §9 #5`).
- `infrastructure/persistence/spec/order.mapper.spec.ts` — round-trip
  сущность → домен для состояний создания и подтверждения.

## Последствия

- Retail теперь соответствует per-module-гексагональной форме
  модулей inventory и notification. Правило границы «`ClientProxy`
  только внутри
  `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`»
  удовлетворено двумя messaging-адаптерами.
- Legacy-папки `app/api/order/` и `app/common/entities/` удалены; их
  TypeORM-сущности перенесены под
  `modules/orders/infrastructure/persistence/`.
- `retail.order.created` теперь впервые имеет реального продюсера —
  notification-потребитель task-07 работал против синтетической
  публикации в `test/notification.e2e-spec.ts` до сих пор.
- Межсервисный поток подтверждения `gateway → retail.order.confirm →
  inventory.order.confirm → notification (retail.order.created из
  пути создания)` впервые прорабатывается сквозно
  `test/system-api.e2e-spec.ts`.
- Семь гейтов проверки (yarn install/build/lint/test:unit, yarn
  test:e2e end-to-end, grep местоположения `@Entity`, отсутствие
  прямой инжекции `Repository<...>` за пределами typeorm-адаптера) —
  все проходят.

## Рассмотренные альтернативы

1. **Записывать `OrderCreated` изнутри фабрики `Order.create` и мутировать `aggregateId` события после сохранения.** Отклонено — `DomainEvent.aggregateId` — `readonly`, а перезапись его через `Object.assign` просочила бы заботу персистентности в домен.
2. **Пропустить кросс-сервисный gateway-порт; инжектить `ClientProxy` напрямую в use case подтверждения.** Отклонено — асимметрия в тестах и была всем смыслом. С портом спек прорабатывает «stock-confirmed / stock-insufficient / timeout» без RabbitMQ; без него юнит-сьют либо мокал бы `firstValueFrom`, либо пропускал эти ветви.
3. **Продвинуть `Customer` до собственного агрегата внутри модуля orders.** Отклонено — сегодня на нём нет поведения (read-only-seed-данные). Агрегат Order владеет своей ссылкой на клиента как `CustomerRef` VO.
4. **Эмитировать `OrderConfirmed` из use case, отражая `stock.low`.** Рассмотрено — но путь подтверждения всегда выполняется против сохранённого агрегата, поэтому запись события внутри `applyInventoryConfirmation(...)` прямолинейна и удерживает переход состояния + эмиссию события совмещёнными. Асимметрия пути создания задокументирована в §5.

## Ссылки

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) —
  per-module-гексагональная цель, которую реализует этот модуль.
- [ADR-011](011-notifier-port-and-adapters.md) /
  [ADR-012](012-stock-aggregate-and-port-adapter.md) —
  per-module-шаблон и inventory-аналог, которые отражает этот
  модуль.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — стек
  TypeORM/MySQL, на котором строится `OrderTypeormRepository`.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — брокер, через
  который путешествуют кросс-сервисный RPC `inventory.order.confirm`
  и событие `retail.order.created`.
