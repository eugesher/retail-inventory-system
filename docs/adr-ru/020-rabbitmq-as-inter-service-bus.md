# ADR-020: RabbitMQ как межсервисная шина сообщений

- **Date**: 2026-05-14
- **Status**: Принято

---

## Контекст

API gateway и три микросервиса обмениваются данными исключительно
через RabbitMQ. Gateway пересылает каждый бизнес-запрос как RPC
владеющему микросервису (`retail.order.create`, `retail.order.confirm`,
`retail.order.get`, `inventory.product-stock.get`); микросервисы
эмитируют события обратно в шину для кросс-сервисного потребления
(`retail.order.created`, `retail.order.confirmed`,
`retail.order.cancelled`, `inventory.stock.low`), с notification-
микросервисом как единственным потребителем событий сегодня.

Этот выбор транспорта предшествует миграции. Кодовая база использует
`@nestjs/microservices` с RabbitMQ-транспортом (`Transport.RMQ`)
сквозно; очереди, клиентские модули и ключи маршрутизации живут в
`libs/messaging`
([ADR-008](008-rabbitmq-via-libs-messaging.md)); auto-instrumentation,
делающая один трейс охватывающим все четыре сервиса
([ADR-014](014-otel-exporter-otlp-http-and-jaeger.md)), цепляется к
жизненному циклу publish/consume `amqplib`, чтобы пробрасывать
`traceparent` через свойства AMQP-сообщения. ADR-008 фиксирует
*соглашения подключения* (где живут модули, точечный формат ключей
маршрутизации), но не фиксирует сам выбор RabbitMQ; это ADR
заполняет пробел.

Решение значимо, потому что каждый архитектурный слой downstream
принимает RabbitMQ как несущее предположение: per-module-
гексагональная компоновка (ADR-004) помещает `@nestjs/microservices`
только внутрь
`infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`;
event-driven-поток notification (ADR-011) предполагает
RMQ-`@EventPattern`-подписки; кросс-сервисный поток подтверждения
(ADR-013) предполагает RMQ-RPC с `ClientProxy.send()`,
материализованным через `firstValueFrom`; правила boundaries (ADR-017)
явно запрещают `amqplib` / `amqp-connection-manager` за пределами
слоя адаптеров.

---

## Решение

Межсервисный транспорт — **RabbitMQ** как для RPC, так и для
fire-and-forget-событий.

**Брокер.** Один брокер RabbitMQ, провижионируемый
`docker-compose.yml` (образ `management`, чтобы web-UI был доступен
на `http://localhost:15672` во время локального dev). Продакшен
может шардировать или кластеризовать; приложения подключаются через
единственную env-переменную `RABBITMQ_URL`, обеспечиваемую
Joi-схемой в `libs/config`.

**Клиентская библиотека.** `@nestjs/microservices` с `Transport.RMQ`,
которая в свою очередь использует `amqplib` через
`amqp-connection-manager` (resilient-reconnecting-обёртка).
Библиотека одна на обеих сторонах: gateway и микросервисы говорят
`ClientProxy` / `@MessagePattern` / `@EventPattern` — никакого
handwritten-AMQP-кода.

**Очереди.** Одна очередь на сервис, определённая в
`@retail-inventory-system/contracts/microservices/microservice-queue.enum.ts`:
`retail_queue`, `inventory_queue`, `notification_events`. Каждый
микросервис привязывает свою очередь на старте
(`app.connectMicroservice({ transport: Transport.RMQ, options: { queue }})`).
Gateway и другие продюсеры отправляют через соответствующий
`ClientProxy`, зарегистрированный через модули
`MicroserviceClient{Retail,Inventory,Notification}Module`,
экспортируемые `libs/messaging`.

**Паттерны messaging.**
- **RPC** (request/response) использует
  `ClientProxy.send(pattern, payload)` и `@MessagePattern(pattern)`.
  Use cases gateway-side оборачивают observable в `firstValueFrom`,
  чтобы вызывающие ожидали обычный `Promise`.
- **События** (fan-out, fire-and-forget) используют
  `ClientProxy.emit(pattern, payload)` и `@EventPattern(pattern)`.
  Публикаторы также материализуют emit с `firstValueFrom`, чтобы
  семантика async/await была единообразной между обоими паттернами.

**Ключи маршрутизации.** Точечные строки `<service>.<aggregate>.<action>`,
определённые как `as const`-константы в `ROUTING_KEYS` (libs/messaging)
и зеркалируемые в `MicroserviceMessagePatternEnum`
(libs/contracts/microservices). Оба имени должны совпадать
значение-в-значение; контракт утверждается
`libs/messaging/spec/routing-keys.constants.spec.ts`. Само соглашение
об именовании принадлежит ADR-008.

**Exchanges.** Сегодня каждая очередь привязана к **exchange по
умолчанию** — аргумент `pattern` в `@nestjs/microservices` резолвится
в ключ маршрутизации, который exchange по умолчанию сопоставляет с
подпиской по шаблону имени очереди. Константы `EXCHANGES` в
`libs/messaging` **зарезервированы** для будущей миграции на
маршрутизацию через topic-exchange (например, `inventory.*.low`,
`retail.order.#`); ни один адаптер сегодня к ним не привязывается.

**Корреляция и трейсинг.**
- Каждый payload расширяет `ICorrelationPayload` из
  `libs/contracts/microservices`; `correlationId` пробрасывается
  middleware gateway (ADR-001) и включается в каждой строке лога,
  которую эмитируют микросервисы.
- `traceparent` (W3C trace context) инжектируется в свойства AMQP-
  сообщения auto-instrumentation OpenTelemetry для `amqplib`
  (ADR-014). Потребители прозрачно его извлекают; один трейс
  охватывает поток gateway → retail → inventory → notification без
  ручного проброса контекста на границах адаптеров.

**Архитектурная граница.** `@nestjs/microservices`, `amqplib` и
`amqp-connection-manager` могут импортироваться **только** из файлов
под
`infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts` (или
эквивалентного `*-rabbitmq.adapter.ts` в gateway). Архитектурный
lint (ADR-017) обеспечивает это; каждый потребитель за пределами
слоя адаптеров идёт через порт (`IInventoryGatewayPort`,
`IInventoryConfirmGatewayPort`, `IOrderEventsPublisherPort`,
`IStockEventsPublisherPort` и т. д.).

**Семантика сбоев.** Сбои RPC всплывают как `RpcException` и
транслируются в HTTP-ошибки gateway через `throwRpcError`. Публикации
событий best-effort; сбой публикации на post-commit-пути
create/confirm логируется на уровне `warn`, но не поднимается —
агрегат уже сохранён, а fan-out уведомлений — best-effort-шаг.
Transactional outbox сегодня нет; будущее ADR вводит его, если
at-least-once-доставка кросс-сервисных событий станет жёстким
требованием.

---

## Рассмотренные альтернативы

**Apache Kafka.** Отклонено для этого проекта. Сильные стороны Kafka
— партиционированные, replayable, упорядоченные логи с offsets
consumer-group — решают проблемы, которых у нескольких RPC и
event-потоков в секунду пока нет. Per-message-ack/nack-модель
RabbitMQ лучше подходит для request/response и для маленькой,
low-fan-out-поверхности событий сегодня. Операционный footprint
важен: Kafka приносит ZooKeeper или KRaft + брокеры + schema registry
+ семантику offset commit; RabbitMQ — это один контейнер.
Пересматривается, если поверхность событий вырастет до потребности
в партиционировании или replay.

**NATS / NATS JetStream.** Отклонено. NATS легче, чем Kafka, и быстрее,
чем RabbitMQ на малых payload, а JetStream добавляет durable streams.
Компромисс — размер сообщества (RabbitMQ имеет больше всего
NestJS-экосистемной документации), зрелость RMQ-транспорта
`@nestjs/microservices` (одна строка `Transport.RMQ`; NATS
поддерживается, но менее обкатан в NestJS) и операционная
знакомость. NATS — разумная будущая замена, если проект упрётся в
потолок производительности RabbitMQ — слой адаптеров, обеспечиваемый
архитектурным линтом, делает замену хирургической.

**Redis Streams или Redis pub/sub.** Отклонено. Проект уже запускает
Redis для кеш-слоя (ADR-002, ADR-006, ADR-016); переиспользование его
в качестве шины сжало бы одну зависимость ценой смешения двух ролей.
Сбой Redis сегодня деградирует кеш до «miss-and-DB-read»
(постепенно); делая его и шиной сообщений тоже, превратит тот же
сбой в «нет межсервисного трафика» (катастрофически). Операционное
разделение забот стоит второго контейнера.

**Прямой service-to-service-HTTP.** Отклонено. HTTP связывает каждый
сервис с именами хостов и доступностью каждого другого сервиса; это
потребовало бы слоя service-discovery, retry-with-backoff и
circuit-breaker-подключения per-call. RabbitMQ обеспечивает
расцепление бесплатно — продюсер не знает, какие (или сколько)
потребителей существуют, а брокер поглощает временные сбои
потребителей. Кросс-сервисный поток подтверждения (ADR-013)
конкретно выигрывает от этого: медленный inventory-микросервис
ставит работу в очередь, а не 503-ит gateway.

**gRPC.** Отклонено. Streaming, code-generation и строгие контракты
gRPC превосходны для высокопроизводительного request/response, но
event-driven-сторона проекта (`retail.order.created`,
`inventory.stock.low`) неудобно отображается на RPC-центричную
модель gRPC. Слой `@retail-inventory-system/contracts/microservices`
уже даёт нам выгоду типизированного контракта без шага компиляции
protobuf.

**In-process event bus (без брокера).** Отклонено. Три сервиса
работают как отдельные процессы; кросс-процессный трафик и есть весь
смысл шины. In-process-шина работает только внутри одного монолита,
что не является топологией деплоя.

---

## Последствия

### Положительные

- Расцепление producer/consumer бесплатно: durability очереди
  поглощает сбои потребителей и пики back-pressure. Медленный
  inventory-сервис не 503-ит gateway.
- Один транспорт для RPC и событий. `@nestjs/microservices` даёт нам
  единообразный `ClientProxy` API для обоих паттернов; та же фабрика
  `RmqOptions` конфигурирует обе стороны.
- Auto-instrumentation amqplib (ADR-014) пробрасывает `traceparent`
  через свойства AMQP-сообщения — каждый кросс-сервисный трейс — это
  одно дерево в Jaeger без ручного кода проброса контекста.
- Архитектурный lint (ADR-017) сжимает broker-aware-поверхность до
  малого набора файлов адаптеров. Каждый другой слой broker-агностичен
  и юнит-тестируем против in-memory-port-stubs.
- Единая операционная зависимость: один контейнер `rabbitmq`
  локально, один managed-брокер в продакшене.

### Отрицательные / компромиссы

- RabbitMQ — это единая точка отказа для межсервисного трафика. Сбой
  брокера останавливает каждый кросс-сервисный поток. Смягчается
  операционной зрелостью RabbitMQ, логикой reconnect
  `amqp-connection-manager` и тем, что gateway возвращает
  RPC-таймауты чисто (без half-state). Production HA — это вопрос
  кластеризации/зеркалирования, а не код-вопрос.
- At-least-once-доставка событий — это default брокера, но публикации
  событий проекта не транзакционно связаны с коммитами БД —
  успешный коммит, за которым следует момент сбоя брокера, может
  потерять следующий emit. Post-commit-публикации логируют warning, а
  не поднимают. Transactional-outbox-ADR — это убедительное будущее
  дополнение, если поверхность событий вырастет до требования более
  сильных гарантий.
- Никакой replay-семантики. Потребитель, пропустивший сообщение,
  потому что был offline (например, notification-микросервис был
  down во время emit `inventory.stock.low`), не увидит сообщения
  позже. События сегодня advisory; outbox + replayable log изменили
  бы этот контракт.
- Изменения wire-формата ключей маршрутизации координируются между
  всеми четырьмя приложениями в одном PR (ADR-008 фиксирует cutover
  snake_case → точечный по этой причине). Polyrepo-разделение или
  независимая каденция релизов усложнили бы это.

---

## Ссылки

- `libs/messaging/` — подключение RabbitMQ, ключи маршрутизации,
  константы exchange.
- `libs/contracts/microservices/` — перечисления queue / pattern /
  client-token / app-name, `ICorrelationPayload`.
- `apps/*/src/modules/*/infrastructure/messaging/` — единственный
  разрешённый дом для импортов `@nestjs/microservices`.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — подключение
  библиотеки messaging и точечный wire-формат ключей маршрутизации.
- [ADR-013](013-order-aggregate-and-cross-service-confirm.md) —
  кросс-сервисный поток подтверждения, сквозно прорабатывающий
  паттерн RPC.
- [ADR-011](011-notifier-port-and-adapters.md) — event-driven-поток
  notification, прорабатывающий `@EventPattern`.
- [ADR-014](014-otel-exporter-otlp-http-and-jaeger.md) — OTel-
  auto-instrumentation amqplib, пробрасывающая `traceparent` через
  каждый хоп брокера.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — правила
  линта, ограничивающие `@nestjs/microservices` / `amqplib` слоем
  адаптеров.
