# ADR-011: NotifierPort и notification-микросервис как эталонный шаблон модуля

- **Date**: 2026-05-13
- **Status**: Принято

---

## Контекст

До task-07 notification-микросервис (`apps/notification-microservice/`)
был заглушкой: `AppModule` регистрировал `ConfigModule` и `LoggerModule`,
`main.ts` подключался к очереди RabbitMQ `notification_events`, и
больше ничего не существовало. Никаких обработчиков, никакой
бизнес-логики, никаких каналов доставки.

ADR-004 установил гексагональную архитектуру по сервисам как целевую
компоновку, ADR-008 зафиксировал wire-формат RabbitMQ, а ADR-009
произвёл gateway-side-реализацию шаблона. Inventory и retail всё ещё на
legacy-плоской компоновке и мигрируют в задачах 08–09. Task-07
поднимает notification-микросервис **правильно с первого раза**, чтобы
он мог служить каноническим эталонным шаблоном модуля, с которого
копируют более крупные сервисы — построить с нуля дешевле, чем
перестроить, а шаблон полезнее до более тяжёлых миграций, а не после.

## Решение

### 1. Notification-микросервис владеет эталонным шаблоном модуля

**Выбрано.** Модуль notification в
`apps/notification-microservice/src/modules/notifications/` —
референсная форма для каждого ограниченного контекста микросервиса:

```
modules/notifications/
  domain/          # value objects, enums, invariants. No `@nestjs/*`.
  application/
    ports/         # port interfaces + DI symbols (Symbol-based)
    use-cases/     # one class per use case; inject ports, not adapters
  infrastructure/
    consumers/     # @EventPattern / @MessagePattern subscribers (RMQ)
    delivery/      # NOTIFIER adapters: log, email, webhook
    *.module.ts    # binds port symbols to concrete adapters
  presentation/    # RMQ-only here (health); HTTP for services that need it
```

Задачи 08 (inventory) и 09 (retail) копируют эту форму дословно для
каждого ограниченного контекста. Разделение отражает компоновки
`modules/auth/` и `modules/retail/` gateway, так что у проекта одна
форма по всем сервисам — а не «гексагональный стиль, но слегка
отличающийся per service».

### 2. `NotifierPort` — исходящая абстракция

**Выбрано.** Прикладной код зависит от
`INotifierPort { send(Notification) }`, а не от конкретного механизма
доставки. DI-символ — `NOTIFIER` (`Symbol`, не строковый токен — то
же соглашение, что используют `RETAIL_GATEWAY_PORT` /
`USER_REPOSITORY`). `notifications.module.ts` привязывает `NOTIFIER` к
конкретному адаптеру; смена log → email → webhook — это однострочное
изменение `useClass`, как только целевой адаптер реализован.

**Отклонено: конкретный `NotifierService` с feature-флагами для
каналов.** Смешивает выбор доставки с бизнес-логикой и насаждает
зависимости каждого адаптера на use case. Порт + множество адаптеров
удерживают use case свободным от webhook URL, SMTP-кредов и SDK
провайдеров.

### 3. `LogNotifierAdapter` — привязка по умолчанию

**Выбрано.** Привязка `NOTIFIER` по умолчанию — `LogNotifierAdapter`,
который эмитирует уведомление как структурированную info-строку Pino.
Это та реализация, которую smoke-тест прорабатывает сквозно.

Обоснование: log-нотификатор — единственный адаптер, у которого
нулевые внешние зависимости и о котором можно рассуждать в
юнит-тестах с Pino-шпионом. Email- и webhook-адаптеры нуждаются в
сетевой доступности, транспортных учётных данных и политиках
повторных попыток — ничего из этого не уместно подключать на
критическом пути миграции. `EmailNotifierAdapter` и
`WebhookNotifierAdapter` существуют как каркасы (TODO), чтобы DI-слот
был виден, а перепривязка была однострочным изменением, когда
прибудет реальная реализация.

### 4. Consumers — это infrastructure, а не presentation

**Выбрано.** Подписчики RabbitMQ живут под `infrastructure/consumers/`.
Это тонкие адаптеры, преобразующие wire-формат payload
(`IRetailOrderCreatedEvent`, `IInventoryStockLowEvent`) в вызовы
use-case, точно так же как HTTP-контроллеры — это адаптеры
presentation-слоя из URL + JSON body в вызовы use-case.

В legacy-плоской компоновке эти обработчики жили под `app/api/*`
рядом с контроллерами, что смешивало исходящее (RMQ subscribe) с
входящим (HTTP route). Разделение по модулям разделяет эти две заботы:
`presentation/` — для HTTP, `infrastructure/consumers/` — для RMQ.

### 5. События — это framework-free-интерфейсы в `libs/contracts`

**Выбрано.** `IRetailOrderCreatedEvent` и `IInventoryStockLowEvent` —
plain TypeScript-интерфейсы в `libs/contracts/retail/events/` и
`libs/contracts/inventory/events/`. Они расширяют
`ICorrelationPayload`, чтобы log correlation работала сквозно, и несут
ISO-строку `occurredAt`, чтобы потребители могли рассуждать о порядке
без доверия к timestamp брокера.

**Отклонено: подклассы `DomainEvent<TId>` для кросс-сервисных
событий.** Эти типы живут в `libs/ddd` и спроектированы для
in-process-диспетчеризации событий агрегата. Кросс-сервисный wire-
формат должен быть plain JSON-формой — никакой class identity для
сериализации, никаких декораторов `@nestjs/*` для перетаскивания за
собой. Эти две заботы делят имя, но не представление; их смешение
вынудило бы каждого потребителя реконструировать класс при получении.

### 6. У микросервиса нет HTTP-поверхности

**Выбрано.** Notification-микросервис — RMQ-only. Health-чек идёт по
тому же транспорту, что и event-подписчики, через
`@MessagePattern('notification.health.ping')`. Если позже добавится
gateway-side `GET /health/notification`, он проксирует на этот
паттерн.

**Отклонено: маленький HTTP-сервер в процессе notification.** Добавляет
второго слушателя, второй порт для экспонирования в Docker и второй
механизм liveness для мониторинга оркестрацией. RMQ-only-поверхность
деплоя меньше и соответствует роли сервиса (у него нет клиентских
запросов — только события брокера).

### 7. Корреляция идёт в строке лога, а не через `PinoLogger.assign`

**Выбрано.** Use cases логируют `correlationId` inline на каждом
вызове `logger.info()`. `PinoLogger.assign()` работает только в
request-scope-режиме nestjs-pino, а event-pattern-обработчики не
request-scoped (нет HTTP-контекста). Попытка `assign()` внутри
обработчика `@EventPattern` выбрасывает
`PinoLogger: unable to assign extra fields out of request scope`.

Это отличается от use-case gateway (например, `CreateOrderUseCase`),
которые вызывают `assign()` — они вызываются из HTTP-контроллеров и
наследуют request-scope. Соглашение такое: **внутри обработчика
`@EventPattern` / `@MessagePattern` передавайте `correlationId` как
поле лога; внутри пути HTTP-контроллера `assign()` нормально.**

### 8. Переиспользовать существующую очередь `notification_events`

**Выбрано.** Заглушка до task-07 уже подключалась к очереди
`notification_events`; мигрированный сервис сохраняет то же имя
очереди (`MicroserviceQueueEnum.NOTIFICATION_EVENTS`). Константа
`EXCHANGES.NOTIFICATION` в `libs/messaging/exchanges.constants.ts`
зарезервирована для будущей миграции на topic-exchange; сегодня
очередь привязана к exchange по умолчанию, и поле `pattern` в
envelope сообщения маршрутизирует внутри потребителя.

## Последствия

- Notification-микросервис теперь потребляет `retail.order.created` и
  `inventory.stock.low`. **Ни один из продюсеров пока не существует** —
  они прибывают в задачах 08 (inventory) и 09 (retail). Smoke-тест
  `test/notification.e2e-spec.ts` прорабатывает полный путь consumer →
  use-case → notifier, публикуя синтетическое событие напрямую в
  очередь.
- `libs/contracts` получает две новые подобласти: `retail/events/` и
  `inventory/events/`. Соглашения wire-формата ADR-008 распространяются
  на события без изменений.
- `ROUTING_KEYS` и `MicroserviceMessagePatternEnum` получают три
  новых значения: `RETAIL_ORDER_CREATED`, `INVENTORY_STOCK_LOW`,
  `NOTIFICATION_HEALTH_PING`. Спек в `libs/messaging/spec/`
  утверждает, что обе библиотеки согласуются по каждому значению.
- `EmailNotifierAdapter` и `WebhookNotifierAdapter` — это каркасы,
  выбрасывающие `not implemented` в `send()`. Никаких новых runtime-
  зависимостей (`nodemailer`, `axios` и т. д.) не добавлено —
  отложено до момента, когда адаптер действительно подключат после
  миграции.
- Задачи 08–09 будут копировать компоновку каталогов модуля
  notification дословно. Если им потребуется отклониться, отклонение
  должно высадиться здесь как follow-up ADR, а не молча в коде.

## Рассмотренные альтернативы (сводка)

| Решение | Выбрано | Отклонено | Почему |
| -------- | ------ | -------- | --- |
| Исходящая абстракция | `NotifierPort` (порт + адаптеры) | `NotifierService` (конкретный с feature-флагами) | Удерживает use cases свободными от SDK/кредов провайдеров. |
| Доставка по умолчанию | Log-адаптер | Email-адаптер | Нулевые внешние зависимости; тестируется Pino-шпионом. |
| Форма кросс-сервисного события | Plain JSON-интерфейсы в `libs/contracts` | Подклассы `DomainEvent<TId>` | Wire-формат ≠ внутренние события агрегата. |
| HTTP-поверхность на notification | Нет — только RMQ | Маленький HTTP-сервер для health | Меньшая поверхность деплоя. |
| Корреляция в event-обработчиках | Inline-поле лога | `PinoLogger.assign` | `assign` работает только в request-scope. |
| Порядок постройки | Notification первым (шаблон) | Notification последним (после крупных сервисов) | Шаблон до перестройки, а не после. |

## Ссылки

- ADR-004 — гексагональная архитектура по сервисам.
- ADR-008 — wire-формат RabbitMQ (`<service>.<aggregate>.<action>`).
- ADR-009 — разделение порт/адаптер gateway (компоновка, которую
  отражает этот модуль).
- ADR-010 — JWT/RBAC в gateway (первый gateway-модуль с настоящим
  `domain/`; это ADR — первый эквивалент для микросервиса).
- ADR-020 — RabbitMQ как межсервисная шина, переносящая события, на
  которые подписан этот модуль.
