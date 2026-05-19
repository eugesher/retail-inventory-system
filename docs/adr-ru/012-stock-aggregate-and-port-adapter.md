# ADR-012: Агрегат stock и разделение порта/адаптера в inventory

- **Date**: 2026-05-13
- **Status**: Принято

---

## Контекст

До task-08 inventory-микросервис был на legacy-плоской компоновке:

- `apps/inventory-microservice/src/app/api/product-stock/`
  - `product-stock.controller.ts` — обработчики `@MessagePattern`.
  - `providers/product-stock-get.service.ts` — RPC для `inventory.product-stock.get`.
  - `providers/product-stock-order-confirm.service.ts` — RPC для `inventory.order.confirm`.
- `apps/inventory-microservice/src/app/common/modules/product-stock-common/`
  - `product-stock-common.service.ts` — фасад с cache-aside-чтением, locked-read-агрегацией, добавлением записи в журнал и инвалидацией SCAN+UNLINK.
  - `providers/product-stock-common-{get,add,cache}.service.ts` — субпровайдеры, каждый владеет одной сквозной заботой.
- `apps/inventory-microservice/src/app/common/entities/` — TypeORM-сущности `Product`, `ProductStock`, `ProductStockAction`, `Storage`.

ADR-002 установил контракт cache-aside для остатков товара; ADR-004
объявил гексагональную архитектуру по сервисам целевой компоновкой;
ADR-011 избрал notification-микросервис каноническим эталонным
шаблоном модуля. Task-08 перестраивает inventory-микросервис в этот
шаблон, сохраняя каждое аудит-помеченное поведение из ADR-002
дословно. Сегодня для миграции есть только один ограниченный контекст —
`stock`, — поэтому это ADR ограничено этим единственным агрегатом.

## Решение

### 1. Один ограниченный контекст `stock`, названный по агрегату

**Выбрано.** Новый модуль живёт в
`apps/inventory-microservice/src/modules/stock/`. Имя следует
доменному агрегату (`Stock` / `StockItem`), а не имени связи
`product-stock`. Имя связи сохраняется в таблице (`product_stock`) и
сущности (`ProductStock`), потому что переименование таблиц MySQL и
сущностей из-под существующих данных рискованно и не даёт ничего,
чего бы уже не дало переименование модуля.

### 2. Доменный слой

- `StockItem` — это чистый класс (не подкласс `AggregateRoot<TId>` —
  см. §6, где обосновано эмитирование событий из use case, а не из
  агрегата). Конструктор обеспечивает:
  - `quantity >= 0`
  - `reservedQuantity >= 0`
  - `reservedQuantity <= quantity`
- `Storage` — это `ValueObject<{ id: string }>` из
  `@retail-inventory-system/ddd`. Равенство структурное; конструктор
  отклоняет пустые строки.
- Три in-process-доменных события расширяют `DomainEvent<number>`:
  `StockReservedEvent`, `StockReleasedEvent`, `StockLowEvent`.

`reservedQuantity` находится в домене, даже хотя слой персистентности
по-прежнему — единственный знаковый журнал (`product_stock`). Инвариант
резервирования принадлежит домену, а не адаптеру; будущая эволюция
журнала (выделенная колонка резервов или отдельный журнал) становится
невидимой для вызывающих.

### 3. Три прикладных порта, три конкретных адаптера

- `IStockRepositoryPort` (DI-символ `STOCK_REPOSITORY`) — входящая
  персистентность. Методы: `findById`, `findBySku`,
  `aggregateForProduct`, `lockedTotalsByProduct`, `appendDeltas`,
  `save`. Адаптер: `StockTypeormRepository` (расширяет
  `BaseTypeormRepository` из `@retail-inventory-system/database`).
- `IStockCachePort` (DI-символ `STOCK_CACHE`) — stock-специфический
  порт кеша, скрывающий форму ключа кеша от use cases. Адаптер:
  `StockRedisCache`, который обращается через `@nestjs/cache-manager`
  + `@keyv/redis` и дословно сохраняет контракт SCAN+UNLINK из
  ADR-002 (резервный путь по имени ключа для не-Redis-backends).
- `IStockEventsPublisherPort` (DI-символ `STOCK_EVENTS_PUBLISHER`) —
  исходящая эмиссия событий. Адаптер: `StockRabbitmqPublisher`,
  оборачивающий `ClientProxy.emit()` и материализацию
  `firstValueFrom`, отмеченную в `_carryover-07 §5 #3`, так что
  прикладной код ожидает обычный Promise и никогда не касается RxJS.

Кеш-порт намеренно stock-специфический (вместо переиспользования
общего `CACHE_PORT` из `libs/cache` напрямую), потому что
существующая инвалидация SCAN+UNLINK, обработка KeyvRedis-namespace и
graceful-degradation `try/catch` достигают глубже поверхности общего
порта. Task-11 пересматривает обобщение кеша; до тех пор
аудит-помеченное поведение живёт в адаптере модуля stock, а не в
use cases.

### 4. Use cases отражают legacy-файлы `*.service.ts`

| Legacy-класс | Новый use case |
|---|---|
| `ProductStockGetService` + `ProductStockCommonService.get` | `GetStockUseCase` |
| `ProductStockOrderConfirmService` | `ReserveStockForOrderUseCase` |
| `ProductStockCommonAddService` + `ProductStockCommonService.add` | `AddStockUseCase` |

Путь чтения cache-aside, транзакционный путь резервирования,
fire-and-forget-инвалидация после коммита, аннотации
`AUDIT-2026-05-08 [CACHE-001/CODE-001]` — все сохранены дословно в
новых use cases. Меняются только компоновка файлов и *форма*
абстракций.

`AddStockUseCase` сегодня сохраняется только для внутреннего
использования (используется `ReserveStockForOrderUseCase` косвенно
через репозиторий). Будущий админский или batch-импортёр может
зависеть от use case, а не от порта репозитория.

### 5. Порог низкого остатка живёт в `libs/contracts/inventory/inventory.constants.ts`

**Выбрано.** Добавлен `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD = 5`
рядом с существующим `INVENTORY_DEFAULT_STORAGE`. Порог читается из
`@retail-inventory-system/contracts`, чтобы notification-микросервис
(который уже получает `threshold` по проводу через
`IInventoryStockLowEvent`) мог использовать то же значение, если ему
понадобится. Env-only-настройка потребовала бы более тесной
связанности с `ConfigService` внутри use case; колонка на
`product_stock` сделала бы порог изменяемым, но ввела бы работу по
миграции без текущей выгоды. Константа — наименьшее обязательство,
удовлетворяющее контракту сегодня.

### 6. События эмитируются из use case, а не из агрегата

**Выбрано.** Use case конструирует экземпляры `StockLowEvent` после
коммита транзакции и пересылает их порту-публикатору. Агрегат
`StockItem` не расширяет `AggregateRoot`; нет `pullDomainEvents()`
для сливания.

Обоснование: legacy `ProductStockOrderConfirmService` уже эмитировал
свой post-commit-invalidate-вызов из сервиса, а не из агрегата.
Продвижение записи события в агрегат потребовало бы материализации
`StockItem` на каждую строку журнала перед записью события, что —
бесполезная аллокация для пути, производящего только знаковые
дельты. Будущая эволюция может продвинуть агрегат до `AggregateRoot`,
если доменная логика вырастет; до тех пор эмиссия на уровне use case
удерживает codepath пропорциональным работе, которую он действительно
выполняет.

### 7. Зарезервированная константа exchange остаётся неиспользованной

`EXCHANGES.NOTIFICATION` в `libs/messaging` по-прежнему
зарезервирована (сегодня очередь `notification_events` привязана к
exchange по умолчанию). Inventory-публикатор эмитирует на
`NOTIFICATION_MICROSERVICE` ClientProxy notification-клиента, который
нацелен на очередь напрямую. Маршрутизация через topic-exchange —
follow-up, если потребуется множество потребителей
`inventory.stock.low`.

### 8. Аннотации аудита кеша сохранены дословно

Каждый комментарий `AUDIT-2026-05-08 [CACHE-NNN]` и
`AUDIT-2026-05-08 [CODE-NNN]` из legacy-кода путешествует со своей
продакшен-строкой в новый модуль. Номера строк обновляются там, где
окружающий код переместился, но текстовое содержание и идентификатор
аудита — нет. Task-11 владеет проходом обобщения для этих пунктов;
это ADR явно — нет.

## Последствия

- Inventory теперь соответствует per-module-гексагональной форме
  модуля notification. Правило границы «`ClientProxy` только внутри
  `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`»
  удовлетворено адаптером-публикатором.
- Legacy-папки `app/api/` и `app/common/` удалены; их TypeORM-сущности
  перенесены под `modules/stock/infrastructure/persistence/`.
- Новый `MicroserviceClientNotificationModule` присоединяется к
  существующим клиентским модулям Retail и Inventory в `libs/messaging`;
  inventory использует его для эмиссии `inventory.stock.low` в очередь
  notification.
- Семь гейтов проверки (yarn install/build/lint/test:unit, yarn
  test:e2e на путях inventory, grep местоположения `@Entity`,
  отсутствие прямой инжекции `Repository<...>` за пределами typeorm-
  адаптера) — все проходят.

## Рассмотренные альтернативы

1. **Пропустить stock-специфический кеш-порт; инжектить `CACHE_PORT` напрямую в use case.** Отклонено, потому что инвалидация SCAN+UNLINK и обработка KeyvRedis-namespace достигают глубже общего порта. Правильное место для обобщения — task-11.
2. **Продвинуть `StockItem` до `AggregateRoot` и эмитировать `StockLowEvent` изнутри агрегата.** Отклонено как преждевременное — см. §6. Легко пересмотреть, если доменная логика вырастет.
3. **Поместить порог низкого остатка в строку `product_stock`.** Отклонено как стоимость миграции без текущей выгоды. Легко поднять до колонки позже, сохраняя поиск порога за use case (константа упоминается в одном месте).
4. **Продолжать эмитировать `inventory.stock.low` через fan-out exchange.** Отложено. Сегодняшняя модель с одним потребителем (очередь notification) достаточна.

## Ссылки

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) —
  per-module-гексагональная цель, которую реализует этот модуль.
- [ADR-011](011-notifier-port-and-adapters.md) — канонический
  per-module-шаблон, которому следует этот модуль.
- [ADR-002](002-redis-cache-aside-product-stock.md) /
  [ADR-016](016-cache-aside-generalized.md) — контракт cache-aside,
  который сохраняет и обобщает stock-cache-адаптер.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — стек
  TypeORM/MySQL, на котором строится `StockTypeormRepository`.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — брокер, на который
  эмитирует публикатор `inventory.stock.low`.
