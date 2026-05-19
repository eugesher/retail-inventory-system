# ADR-008: Подключение RabbitMQ через `libs/messaging` и точечные ключи маршрутизации

- **Date**: 2026-05-10
- **Status**: Принято

---

## Контекст

До task-04 подключение RabbitMQ жило в трёх местах:

- `libs/common/config/microservice-client-configuration.ts` — асинхронная
  фабрика, производящая `RmqOptions` из `ConfigService`.
- `libs/common/modules/microservice-client-{retail,inventory}.module.ts`
  — Nest-модули, регистрирующие сконфигурированный клиент под
  перечислением-токеном.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`
  — `MicroserviceMessagePatternEnum` со snake_case-значениями
  (`retail_order_create`, `inventory_product_stock_get`, …).

Заботы подключения (фабрики, модули, идентификаторы exchange) и
константы ключей маршрутизации принадлежат одной библиотеке;
гексагональная цель ADR-004 требует, чтобы доменный код зависел от
порта-публикатора, а не напрямую от типов `@nestjs/microservices`.
Рекомендация выделяет `libs/messaging` как дом для библиотеки
ограниченного контекста messaging.

Это ADR фиксирует структурные решения для этого перемещения и
соглашение об именовании ключей маршрутизации.

## Решение

### `libs/messaging` содержит всё подключение RabbitMQ

| Экспорт | Роль |
|--------|------|
| `MicroserviceClientConfiguration` | Асинхронная фабрика, производящая `RmqOptions` из `ConfigService`. Та же форма, что раньше — перенесена, не переписана. |
| `MicroserviceClientRetailModule`, `MicroserviceClientInventoryModule` | Предподключённые Nest-модули, регистрирующие клиенты retail/inventory под их токенами `MicroserviceClientTokenEnum`. |
| `MessagingModule` | Удобный агрегатор, импортирующий оба клиентских модуля и ре-экспортирующий их. |
| `RabbitmqClientFactory.create(configService, queue)` | Возвращает одноразовый `ClientProxy` для заданной очереди. Используйте это в тестах и bootstrap-скриптах, которым нужен proxy без регистрации Nest-провайдера. |
| `ROUTING_KEYS` | Замороженный объект `as const`, отражающий `MicroserviceMessagePatternEnum`. Идиоматический объект-константа для новых вызывающих; `MicroserviceMessagePatternEnum` остаётся для обратной совместимости. |
| `EXCHANGES` | Замороженный объект `as const`: `{ RETAIL: 'retail', INVENTORY: 'inventory', NOTIFICATION: 'notification' }`. RabbitMQ сегодня использует одну очередь на сервис без явных exchange; константы высаживаются здесь, чтобы будущая миграция на маршрутизацию через topic-exchange имела дом. |

`MicroserviceQueueEnum` и `MicroserviceClientTokenEnum` остаются в
`libs/contracts/microservices` (их канонический дом) и
ре-экспортируются из `libs/messaging` для удобства вызывающих.

### Wire-формат ключей маршрутизации: точечный, не snake_case

`MicroserviceMessagePatternEnum` ранее содержал snake_case-строки:

```
inventory_product_stock_get
inventory_order_confirm
retail_order_create
retail_order_confirm
retail_order_get
```

Переименовано в точечный формат `<service>.<aggregate>.<action>`:

```
inventory.product-stock.get
inventory.order.confirm
retail.order.create
retail.order.confirm
retail.order.get
```

Это соответствует соглашениям AMQP о ключах маршрутизации (токены,
разделённые точкой) и оставляет дверь открытой для маршрутизации
через topic-exchange в будущем (`inventory.*.get`, `retail.order.#`).
Kebab-case (`product-stock`) внутри токена сохраняет имя
многословного агрегата без столкновения с разделителем-точкой.

Переименование **ломает wire-формат**: gateway и микросервисы должны
согласиться о значении. Мы выбрали **План A** — переключить обе
стороны в одном PR — по двум причинам:

1. Репозиторий деплоит все четыре приложения вместе; нет
   переходного окна «gateway на snake_case неделю, микросервис на
   точечном».
2. Тестовая инфраструктура сбрасывается на каждом запуске
   (`yarn test:infra:reload`), так что никакие in-flight-сообщения не
   переживают cutover.

`MicroserviceMessagePatternEnum` сохраняет имена своих идентификаторов
и переключает значения; `ROUTING_KEYS` экспонирует те же строки.
Вызывающие, импортировавшие перечисление, продолжают компилироваться;
поменялся только wire-формат.

### Доменный код зависит от порта-публикатора (отложено)

Сегодня RabbitMQ `ClientProxy` инжектируется напрямую сервисами,
которые публикуют (например,
`retail-microservice/.../order-confirm.service.ts` отправляет
`inventory.order.confirm` через `ClientProxy`, привязанный по
`MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE`). По ADR-004
долгосрочная форма такова:

- Доменный слой определяет `IMessagePublisher` (или подобный).
- Адаптер в `libs/messaging` (или на стороне приложения) реализует
  его через `ClientProxy`.
- Доменный код никогда не импортирует `@nestjs/microservices`.

Этот порт высаживается в task-08/task-09, когда выполняется
гексагональная переорганизация по сервисам. Task-04 намеренно
останавливается на переносе существующего подключения; введение
порта-публикатора в той же задаче запутало бы «структурное
перемещение» с «изменением API» и раздуло бы диф.

## Последствия

- **+** Всё подключение RabbitMQ сгруппировано, что делает будущее
  введение порта-публикатора механическим.
- **+** Ключи маршрутизации следуют конвенции AMQP; будущая
  маршрутизация через topic-exchange имеет чистый путь миграции.
- **+** Новые вызывающие тянутся к `ROUTING_KEYS` (идиоматические
  константы); существующие вызывающие, использующие
  `MicroserviceMessagePatternEnum`, продолжают работать.
- **−** Ломка wire-формата требует, чтобы gateway и каждый
  микросервис деплоились вместе. Приемлемо при all-in-one-деплое.
- **−** Сегодня нет порта-публикатора. Доменный код в retail/inventory
  всё ещё импортирует `@nestjs/microservices`. Отслеживается для
  task-08/09.

## Рассмотренные альтернативы

- **План B: сохранить snake_case-ключи маршрутизации.** Отклонено:
  оставляет строки ключей маршрутизации несогласованными с
  соглашениями AMQP и закрывает миграцию на topic-exchange.
  Миграция — самый дешёвый момент для починки имён — все потребители
  деплоятся вместе.
- **Переместить только модули, оставить ключи маршрутизации в
  `libs/contracts`.** Отклонено: объект-константа плюс перечисление
  с теми же значениями — это и есть то, что увязало перемещение в
  библиотечное решение, а не задачу только по перечислению.
  Размещение констант рядом с потребляющим их кодом подключения
  удерживает ментальную модель проще.
- **Ввести порт-публикатор сейчас.** Отклонено: расширение области.
  Лучше как сфокусированный шаг в task-08/task-09 рядом с
  гексагональной переорганизацией потребляющих сервисов.

---

## Ссылки

- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — выбор брокера, на
  котором сидят соглашения подключения этого ADR.
- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) —
  гексагональная компоновка, внутри которой высаживается follow-up
  по порту-публикатору.
