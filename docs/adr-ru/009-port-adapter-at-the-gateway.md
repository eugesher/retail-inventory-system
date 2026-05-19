# ADR-009: Разделение порта и адаптера в API gateway

- **Date**: 2026-05-10
- **Status**: Принято

---

## Контекст

ADR-004 обязывает проект к гексагональной компоновке по модулям для
каждого сервиса в `apps/`. Task-05 высаживает структурное изменение
для API gateway (`apps/api-gateway/`).

До task-05 gateway был плоским:

```
apps/api-gateway/src/app/api/
├── order/
│   ├── order.controller.ts
│   ├── order.module.ts
│   ├── pipes/order-confirm.pipe.ts
│   └── providers/
│       ├── order-create.service.ts
│       └── order-confirm.service.ts
└── product/
    ├── product.controller.ts
    ├── product.module.ts
    ├── dto/product-stock-get-query.dto.ts
    └── providers/product-stock-get.service.ts
```

Каждый provider напрямую инжектил `ClientProxy` из
`@nestjs/microservices`, вызывал
`client.send(MicroserviceMessagePatternEnum.X, …)` и возвращал ответ
контроллеру. Pipe также держал `ClientProxy` и отправлял
`RETAIL_ORDER_GET` inline. Не было шва между «что этому gateway нужно
спросить у downstream-сервиса» и «как сообщение достигает RabbitMQ» —
замена транспорта (или его подмена для юнит-тестов) требовала глобально
подменить Nest microservice-client.

Pre-migration-рекомендация явно запрещала инжекцию `ClientProxy` из
контроллера и требовала пары `*.gateway.port.ts`-адаптеров; живая
форма этого правила зафиксирована в абзаце «Boundary rule»
`CLAUDE.md` и обеспечивается
[ADR-017](017-architecture-lint-via-eslint-boundaries.md). Gateway
нуждается в той же слоистой форме, что и каждый другой сервис, чтобы
правила архитектурного линта применялись единообразно.

## Решение

### Гексагональная компоновка по модулям

Gateway переходит с `app/api/<feature>/` на
`modules/<feature>/{application,infrastructure,presentation}/`:

```
apps/api-gateway/src/
├── app/app.module.ts
├── common/utils/throw-rpc-error.util.ts
├── main.ts                              # first import: @retail-inventory-system/observability/tracer
└── modules/
    ├── retail/
    │   ├── application/
    │   │   ├── ports/retail-gateway.port.ts        # IRetailGatewayPort + RETAIL_GATEWAY_PORT
    │   │   └── use-cases/
    │   │       ├── confirm-order.use-case.ts       # ConfirmOrderUseCase
    │   │       └── create-order.use-case.ts        # CreateOrderUseCase
    │   ├── infrastructure/
    │   │   ├── messaging/retail-rabbitmq.adapter.ts
    │   │   └── retail.module.ts                    # @Module — wires the adapter
    │   └── presentation/
    │       ├── order.controller.ts                 # POST/PUT /api/order…
    │       └── pipes/order-confirm.pipe.ts
    └── inventory/
        ├── application/
        │   ├── ports/inventory-gateway.port.ts     # IInventoryGatewayPort + INVENTORY_GATEWAY_PORT
        │   └── use-cases/get-product-stock.use-case.ts
        ├── infrastructure/
        │   ├── messaging/inventory-rabbitmq.adapter.ts
        │   └── inventory.module.ts
        └── presentation/
            ├── product.controller.ts               # GET /api/product/:id/stock
            └── dto/product-stock-get-query.dto.ts
```

Два верхнеуровневых модуля называются **retail** и **inventory** —
по *downstream*-сервису, с которым общается proxy, а не по
публичному префиксу URL. Это удерживает внутреннюю ментальную модель
gateway согласованной с микросервисом, перед которым он стоит
(`retail-microservice` → `modules/retail`), независимо от того, как
URL позже переписывается.

### У gateway нет `domain/`

Gateway не держит собственного агрегатного состояния — это
presentation плюс исходящий транспортный адаптер. Папка `domain/`
поэтому опущена из модулей retail и inventory. Task-06 вводит
`modules/auth/` с настоящим `domain/` (User, Role) — это единственный
модуль на gateway, владеющий enforced-состоянием.

### Контроллеры, use-cases и pipes никогда не инжектят `ClientProxy`

Правило границы такое: `ClientProxy` (и любой другой тип
транспортного слоя из `@nestjs/microservices`) разрешён только в
`infrastructure/messaging/*-rabbitmq.adapter.ts`. Каждый другой слой
зависит от символа порта.

| Слой | Общается с RabbitMQ через | Заметки |
|-------|----------------------|-------|
| `presentation/` (контроллер, pipe) | use-case (контроллер) или порт (pipe) | Pipes — это presentation, но работают до контроллера; они могут инжектить порт напрямую, когда их работа — валидировать через транспортный вызов. |
| `application/use-cases/` | символ порта, инжектируемый через Nest DI | Здесь живут логирование, трансляция ошибок, бизнес-намерения. |
| `application/ports/` | — | Файл порта объявляет интерфейс и DI-символ. Никакого импорта `@nestjs/microservices`. |
| `infrastructure/messaging/<svc>-rabbitmq.adapter.ts` | `ClientProxy` из per-service-модуля `MicroserviceClient*Module` | Единственное место, которое знает о ключах маршрутизации и `client.send()`. |
| `infrastructure/<svc>.module.ts` | привязывает `provide: <PORT>, useClass: <Adapter>` | По одному Nest-модулю на каждый gateway-side-ограниченный контекст. |

Pipe (`OrderConfirmPipe`) также инжектит порт. Он вызывает
`getOrderStatus(id)`, третий метод на `IRetailGatewayPort`, который
существует именно потому, что pipe нуждается в чтении статуса до
подтверждения. Помещение pipe за порт удерживает правило
«`ClientProxy` живёт только в адаптерах» абсолютным.

### Ключи маршрутизации: использовать новые константы `ROUTING_KEYS`

Адаптеры ссылаются на `ROUTING_KEYS.RETAIL_ORDER_CREATE` и т. д. из
`@retail-inventory-system/messaging` вместо
`MicroserviceMessagePatternEnum` (сохранённого для обратной
совместимости по ADR-008). Это правило для свежей записи — task-05
не переключила существующие места вызова в микросервисах, это
сфокусированный проход очистки в task-14.

### `main.ts` загружает OpenTelemetry первым

Первая исполняемая строка `apps/api-gateway/src/main.ts` —

```ts
import '@retail-inventory-system/observability/tracer';
```

Тело `tracer.ts` сегодня пустое (заполняется в task-10). Импорт
подключён сейчас, чтобы cutover в task-10 не требовал изменений в
`main.ts`. OTel должен инициализироваться до `NestFactory.create*()`,
чтобы auto-instrumentation успела пропатчить модули HTTP, MySQL
(TypeORM), Redis и AMQP — это требование ограничивает порядок
bootstrap, даже несмотря на то, что тело сегодня no-op.

### Payload `RETAIL_ORDER_GET` сохранён как есть

Pipe до task-05 отправлял через `RETAIL_ORDER_GET` только числовой
order id (без `correlationId`). Новый метод адаптера
`getOrderStatus(id)` сохраняет эту wire-форму дословно — переключение
её на включение `correlationId` потребовало бы скоординированного
изменения на обработчике `@MessagePattern` retail-микросервиса, что
вне области выравнивания gateway. Пробел подтверждён в
`_carryover-05.md`; исправление высаживается вместе с введением
порта-публикатора в task-08/task-09.

## Последствия

- **+** Gateway соответствует гексагональной компоновке, которую
  остальные сервисы принимают в задачах 06–09. Правила
  архитектурного линта в task-12 могут трактовать все `apps/*`
  единообразно.
- **+** Замена RabbitMQ на другой транспорт в gateway теперь
  одно-файловое изменение (адаптер). Use-cases и pipe остаются
  нетронутыми.
- **+** Use-cases юнит-тестируемы против in-memory-заглушки порта
  (не требуется Nest microservice-обвязка).
- **−** Один лишний слой косвенности на исходящий вызов. Контроллер
  теперь вызывает use-case, который вызывает порт; тело use-case
  сегодня тонкое (он логирует, транслирует ошибки и пересылает), но
  косвенность — это шов, к которому обязывает ADR-004.
- **−** Два метода на `IRetailGatewayPort` несут `correlationId` как
  явный параметр; `getOrderStatus` — нет. Асимметрия отражает
  wire-формат и задокументирована на порту — follow-up-задача
  выравнивает её.

## Рассмотренные альтернативы

- **Пропустить слой use-case; контроллеры вызывают порт напрямую.**
  Отклонено: дало бы компоновку, в которой `application/` gateway
  пуст, ломая единообразную форму, предписываемую ADR-004. Use-case
  намеренно тонкий сегодня; он несёт заботы логирования и
  трансляции ошибок, ранее жившие в per-action-сервисе, и даёт
  task-06 очевидное место для наслоения `auth`-зависимой логики.
- **Сохранить инжекцию `ClientProxy` в pipe.** Отклонено: гейт
  проверки «нет `ClientProxy` за пределами адаптеров» провалился бы,
  и pipe стал бы исключением, которое будущие читатели должны
  помнить. Дешевле добавить `getOrderStatus` к порту.
- **Назвать модули `order/` и `product/` (соответственно URL).**
  Отклонено: URL — это деталь presentation; *ограниченный контекст*,
  с которым общается proxy, — это `retail-microservice` /
  `inventory-microservice`. Именование по downstream-сервису делает
  межприложенческую границу видимой на уровне каталога и
  соответствует компоновке, которую сами микросервисы принимают в
  задачах 08–09.
- **Переместить `app.module.ts` из `apps/api-gateway/src/app/` в
  корень `src/`** (точно соответствуя диаграмме рекомендации).
  Отложено: требует обновления путей `tsconfig.json` и
  `jest.e2e.config.js`. Косметично; несущая структура (per-module-
  папки, разделение порт/адаптер) на месте. Отслеживается для
  очистки в task-14.

---

## Ссылки

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) —
  гексагональная цель по сервисам, которую реализует это
  выравнивание gateway.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — wire-формат ключей
  маршрутизации, потребляемый адаптерами gateway.
- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — компоновка
  apps/libs монорепозитория, внутри которой сидит gateway.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — транспорт,
  оборачиваемый messaging-адаптером.
