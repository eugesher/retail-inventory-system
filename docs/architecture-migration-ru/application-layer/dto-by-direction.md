---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, application-layer, dto, contracts]
status: final
related:
  - "[[use-cases-vs-fat-services]]"
  - "[[notifier-port-and-adapters]]"
  - "[[hexagonal-architecture]]"
  - "[[clean-architecture-layers]]"
  - "[[shared-libs-philosophy]]"
  - "[[mappers-and-repositories]]"
  - "[[message-vs-event-patterns]]"
  - "[[routing-keys-and-contracts]]"
  - "[[entity-vs-domain-model]]"
---

# DTO по направлению потока

> [!abstract] Кратко
> В проекте действует **пять (плюс один) суффиксов DTO**,
> каждый — про конкретное направление потока данных:
> `*.request.dto.ts` — то, что приходит снаружи (HTTP-body
> или RPC-payload); `*.response.dto.ts` — то, что уходит
> наружу; `*.command.ts` — write-вход application-слоя
> (use-case ждёт такой объект); `*.query.ts` — read-вход;
> `*.view.ts` — read-выход (проекция, не агрегат). Плюс шестой
> на стыке: `*.event.ts` для cross-service-событий. Эта
> конвенция зафиксирована в
> [`recommendation.md` §4](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L241-L273)
> и блокирует один из задокументированных pattern-to-avoid'ов
> ([`recommendation.md` §5](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L274-L289)):
> «Using a single shared DTO for HTTP, RPC, persistence, and
> events». В проекте `*.view.ts` и часть `*.query.ts` —
> зарезервированные слоты, материализованы по мере появления
> use-case'а, которому они нужны.

## Проблема, которую решает

«Один DTO на всё» — естественная стартовая позиция в новых
NestJS-проектах. Сценарий выглядит так: появляется
`OrderDto` с decorator'ами `class-validator` (`@IsInt`,
`@IsPositive`), его кладут в `libs/contracts`, и затем тот
же класс используют четыре разных места:

1. **HTTP-controller** — `@Body() dto: OrderDto`. Здесь
   validator'ы — то, что нужно: пришло не то — 400.
2. **RPC-handler** — `@MessagePattern(...)` с payload'ом
   `OrderDto`. На границе microservice'а validator'ы тоже
   полезны.
3. **Persistence** — `repository.save(dto)`. Тут уже
   странно: дайте ORM-у entity, а не DTO с decorator'ами.
4. **Event publishing** — `client.emit('retail.order.created',
   dto)`. Wire-формат теперь несёт `class-validator`-метаданные.

Все четыре варианта работают **сегодня**, и именно поэтому
антипаттерн так живуч. Болит он позже:

- **Один тип течёт через все слои** — поменять имя поля
  означает поменять HTTP-API, RPC wire-формат, persistence
  и событие синхронно. Это **broken encapsulation**: внешний
  HTTP-клиент диктует имена колонок в БД.
- **`class-validator`-метаданные в wire-формате.** События в
  RabbitMQ — это JSON. `class-validator` для JSON-payload'а
  бесполезен, но decorators тянут зависимость через
  serialize/deserialize, и при reflect-metadata-неправильно
  сконфигурированном consumer'е приходят разные ошибки.
- **Внутренние имена утекают наружу.** Сегодня в БД колонка
  `order_id` называется так. Завтра реорганизация: но
  переименовать колонку нельзя — её имя ушло в response.
- **Inbound и outbound DTO имеют разные обязанности.**
  Inbound — это «принять и валидировать»; outbound — это
  «expose и swagger-документировать». У них **разный набор
  полей** (на inbound нет `id`, на outbound нет валидаторов),
  и одной формы достаточно только в простейших CRUD-приложениях.

[`recommendation.md` §5](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L274-L289)
прямо называет это анти-паттерном:

> ❌ Using a single shared DTO for HTTP, RPC, persistence, and
> events.

И предлагает «teg направление в суффикс файла».

## Концепция

### Что фиксируем

Конвенция (`recommendation.md` §4) — пять основных суффиксов:

| Суффикс | Слой | Слой-источник | Направление |
|---------|------|---------------|-------------|
| `*.request.dto.ts` | presentation | HTTP / RPC inbound | внешний → app |
| `*.response.dto.ts` | presentation | HTTP / RPC outbound | app → внешний |
| `*.command.ts` | application | use-case write input | presentation → use-case (write) |
| `*.query.ts` | application | use-case read input | presentation → use-case (read) |
| `*.view.ts` | application | use-case read output | use-case → presentation (projection) |

Плюс — шестой суффикс, который `recommendation.md` §4 не
перечисляет, но который проект использует везде:
`*.event.ts` для cross-service wire-event'ов (производные от
ADR-008 и ADR-011, см. ниже).

Принцип одной строкой: **суффикс кодирует, в какую сторону
течёт данный объект**. По нему сразу видно, какой набор
ограничений к нему применим.

### Что в каждой категории живёт, а что — нет

**`*.request.dto.ts`** — это **класс** с
`class-validator`-decorator'ами и `@ApiProperty`. Его задача —
быть валидируемым на границе. Не передавать дальше в
use-case в этой форме: use-case ждёт **command**, а не
request-DTO.

**`*.response.dto.ts`** — тоже класс, с `@ApiResponseProperty`
(NestJS Swagger), но **без** `class-validator`-decorator'ов.
Response не валидируется снова — это то, что мы возвращаем,
не то, что принимаем. Если поле есть на response — оно
гарантированно есть в результате use-case'а.

**`*.command.ts`** — простой **интерфейс**, без класс-
декораторов. Это то, что use-case ждёт на вход. Конвертирует
из request DTO либо presentation-слой (controller +
class-transformer), либо pipe.

**`*.query.ts`** — то же, но для read-операций. В проекте
большинство read-payload'ов лежит в `libs/contracts/<service>/`
с суффиксом `.types.ts` или интерфейсом `I*Payload extends
ICorrelationPayload`. Чистый `.query.ts` — зарезервированный
слот для будущего, когда появятся read-сценарии с богатым
input'ом (фильтры, пагинация, sort).

**`*.view.ts`** — интерфейс или класс, описывающий
**проекцию** для read'а. В сегодняшней кодовой базе
`*.view.ts`-файлов нет (см.
[`recommendation.md` §4](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L250-L255)
и `grep -r "\.view\.ts" apps libs` → 0). Простые read'ы
возвращают `*.response.dto.ts` (например,
`OrderConfirmResponseDto`), который технически выполняет
роль view. По мере того как появятся read'ы с
не-1-к-1-проекциями (например, «order summary с rolled-up
totals из нескольких таблиц»), они оформятся как
`*.view.ts`.

**`*.event.ts`** — wire-формат cross-service-события. Plain
TypeScript-interface, расширяющий `ICorrelationPayload`. Без
`@nestjs/*`-decorator'ов — событие сериализуется через
JSON, никаких class-identity, никакого `reflect-metadata` на
другой стороне канала.
[ADR-011 §5](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/011-notifier-port-and-adapters.md)
явно отказывается от `DomainEvent<TId>`-subclass'ов в
качестве wire-format: domain-event живёт в `libs/ddd` для
in-process dispatch'а, cross-service event — это JSON.

### Почему направление, а не «layer»

Альтернатива — называть файлы по слою, в котором они живут
(`*.dto.ts` в `presentation/`, `*.dto.ts` в `application/dto/`).
Это работает, но **не передаёт намерение**. Файл `*.dto.ts`
без направления заставит читателя открыть его и посмотреть,
какие decorator'ы навешаны, чтобы понять — это inbound HTTP
или outbound RPC. Суффикс по направлению решает это **через
имя файла**, без открытия.

Дополнительно: суффикс позволяет линту вынести правило типа
«`*.request.dto.ts` должны содержать только `class-validator`-
decorator'ы; `*.response.dto.ts` — только
`@ApiResponseProperty`». Сегодня такого `eslint-rule` в проекте
нет, но конвенция оставляет дверь открытой.

## Применение в проекте

### `OrderCreateDto` — input на gateway

Пример «классической пары» `request` + `response` — на стороне
retail-gateway-модуля, для `POST /api/order`:

```typescript
// libs/contracts/retail/dto/order-create.dto.ts
class OrderCreateProductDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  public productId: number;

  @ApiProperty({ example: 2 })
  @IsInt()
  @IsPositive()
  public quantity: number;
}

export class OrderCreateDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  public customerId: number;

  @ApiProperty({ type: [OrderCreateProductDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderCreateProductDto)
  public products: OrderCreateProductDto[];
}
```

> [GitHub: libs/contracts/retail/dto/order-create.dto.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/retail/dto/order-create.dto.ts#L1-L30)

Что бросается в глаза: файл называется `order-create.dto.ts`,
не `order-create.request.dto.ts`. Это легаси из до-миграции —
он действительно играет роль request-DTO (валидаторы есть,
полей outbound'ных нет). Конвенция `recommendation.md` §4
говорит «`*.request.dto.ts`», но для одиночного «суммарного»
DTO в `libs/contracts` старое имя сохранено. Внутри
gateway'я (см. ниже про auth) есть `login.request.dto.ts` —
там новое имя.

Pair-выход для того же сценария:

```typescript
// libs/contracts/retail/dto/order-create-response.dto.ts
export class OrderCreateResponseDto {
  @ApiResponseProperty()
  public orderId: number;

  @ApiResponseProperty({ enum: OrderStatusEnum })
  public status: OrderStatusEnum;

  @ApiResponseProperty()
  public message: string;
}
```

> [GitHub: libs/contracts/retail/dto/order-create-response.dto.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/retail/dto/order-create-response.dto.ts#L1-L14)

Замечаем три вещи:

1. `@ApiResponseProperty` вместо `@ApiProperty` — для swagger
   это «не нужно ждать на input», а «появится на output».
2. **Нет `class-validator`-decorator'ов.** Response не нужно
   валидировать — это то, что мы возвращаем, не то, что мы
   принимаем.
3. `orderId` есть в response, но не в request — потому что
   request получает на вход «список продуктов и
   customer-id», а order-id ещё не существует. Это **разный
   набор полей** — то, ради чего конвенция и существует.

### `IOrderCreatePayload` — RPC-формат + command-семантика

Между controller'ом на gateway и controller'ом на retail-
microservice ходит RPC через RabbitMQ. Контракт wire-формата
описан как plain TypeScript-интерфейс:

```typescript
// libs/contracts/retail/interfaces/order-create.interface.ts
import { ICorrelationPayload } from '../../microservices';
import { OrderCreateDto } from '../dto';

export interface IOrderCreatePayload extends ICorrelationPayload, OrderCreateDto {}
```

> [GitHub: libs/contracts/retail/interfaces/order-create.interface.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/retail/interfaces/order-create.interface.ts#L1-L4)

Интересный момент: `IOrderCreatePayload` **расширяет**
`OrderCreateDto`. Class extends interface — это
TypeScript-conditional: интерфейс получает все public-поля
класса (без validator'ов — они runtime, на типах их нет).
Добавляется `ICorrelationPayload` ({ correlationId: string }),
который превращает «голую DTO» в полноценный RPC-payload.

На стороне retail-microservice это и есть «command» для use-
case'а — `CreateOrderUseCase.execute(payload:
IOrderCreatePayload)`. Конвенция `*.command.ts` (отдельный
файл с command-формой) **в retail-сервисе не используется**
— payload и command совпадают, так что отдельного command-
файла нет. Это легитимное упрощение: когда payload и
command совпадают, дублировать тип нет смысла.

Где `*.command.ts` действительно есть — на gateway, в auth-
модуле:

```typescript
// apps/api-gateway/src/modules/auth/application/dto/login.command.ts
export interface ILoginCommand {
  email: string;
  password: string;
}
```

```typescript
// apps/api-gateway/src/modules/auth/application/dto/refresh.command.ts
export interface IRefreshCommand {
  refreshToken: string;
}
```

> [GitHub: apps/api-gateway/src/modules/auth/application/dto/login.command.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/application/dto/login.command.ts#L1-L4)
>
> [GitHub: apps/api-gateway/src/modules/auth/application/dto/refresh.command.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/application/dto/refresh.command.ts#L1-L3)

И парная request-DTO в presentation-слое того же модуля:

```typescript
// apps/api-gateway/src/modules/auth/presentation/dto/login.request.dto.ts
export class LoginRequestDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  @MaxLength(255)
  public email: string;

  @ApiProperty({ example: 'customer1234' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password: string;
}
```

> [GitHub: apps/api-gateway/src/modules/auth/presentation/dto/login.request.dto.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/presentation/dto/login.request.dto.ts#L1-L16)

Два файла, одна семантика. `LoginRequestDto` — то, что
приходит из HTTP-`@Body()`; `ILoginCommand` — то, что
ожидает `LoginUseCase.execute(...)`. **Поля одинаковые**, но:

- `LoginRequestDto` — класс с decorator'ами; работает
  ValidationPipe.
- `ILoginCommand` — интерфейс без runtime-обвязки; нечего
  валидировать второй раз.

В controller'е происходит конвертация (Nest сам передаст
поля; structural-subtyping TypeScript позволяет передать
`LoginRequestDto` туда, где ждут `ILoginCommand`, если поля
совпадают). Это явная **граница** между «принять и
валидировать» и «исполнить». Если завтра валидация
усложнится (cross-field-проверки) — она остаётся в
request-DTO; use-case `LoginUseCase` не меняется.

### `OrderConfirmResponseDto` — projection в роли view

`OrderConfirmResponseDto` — это полезный кейс для разговора о
«view vs response»:

```typescript
// libs/contracts/retail/dto/order-confirm-response.dto.ts
class OrderConfirmProductStatusResponseDto {
  @ApiResponseProperty()
  public id: OrderProductStatusEnum;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public color: string;
}

class OrderConfirmProductResponseDto {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public productId: number;

  @ApiResponseProperty({ type: OrderConfirmProductStatusResponseDto })
  public status: OrderConfirmProductStatusResponseDto;
}

class OrderConfirmStatusResponseDto {
  @ApiResponseProperty()
  public id: OrderStatusEnum;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public color: string;
}

export class OrderConfirmResponseDto {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty({ type: OrderConfirmStatusResponseDto })
  public status: OrderConfirmStatusResponseDto;

  @ApiResponseProperty({ type: [OrderConfirmProductResponseDto] })
  public products: OrderConfirmProductResponseDto[];
}
```

> [GitHub: libs/contracts/retail/dto/order-confirm-response.dto.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/retail/dto/order-confirm-response.dto.ts#L1-L48)

Этот DTO — **проекция**: вложенные `*StatusResponseDto`
несут поля `name` и `color`, которых нет в самом агрегате
`Order` (они приходят из reference-таблиц `order_status` и
`order_product_status` через JOIN). Use-case (`ConfirmOrderUseCase`)
не вычисляет этот shape — за projection отвечает репозиторий
(`IOrderRepositoryPort.findOrderResponse`):

```typescript
// apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts
// ...
// `findOrderResponse` returns the full `OrderConfirmResponseDto` (joined
// status reference rows for `name` / `color`). It sits behind the port so
// the use case stays a thin coordinator ...
findOrderResponse(id: number): Promise<OrderConfirmResponseDto | null>;
```

> [GitHub: apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts#L19-L27)

В будущем такой projection логичнее переименовать в
`order-confirm.view.ts` (use-case возвращает view, controller
сериализует view в response). Сегодня оба слоя совпадают и
типы reused через `libs/contracts/retail/dto/`. Один из тех
случаев, когда конвенция допускает упрощение, а не диктует
ceremony.

### `IProductStockGetPayload` + `ProductStockGetResponseDto` — пара read'а

Аналогичная пара для inventory:

```typescript
// libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.types.ts
export interface IProductStockGetPayload extends ICorrelationPayload {
  productId: number;
  storageIds?: string[];
}
```

> [GitHub: libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.types.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.types.ts#L1-L7)

`IProductStockGetPayload` — это типичный query (хотя файл
называется `*.types.ts`, не `*.query.ts`): структурно — read-
вход application-слоя. По канону мог бы быть
`product-stock-get.query.ts`; легаси имя сохранено,
потому что переименование `libs/contracts`-файлов было бы
breaking-change для всех consumer'ов сразу. Структура
правильная — имя дрейфующее.

Пара на выходе:

```typescript
// libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.response.dto.ts
class ProductStockStockItemDto {
  @ApiResponseProperty()
  public storageId: string;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public updatedAt: Date;
}

export class ProductStockGetResponseDto {
  @ApiResponseProperty()
  public productId: number;
  // ...
  @ApiResponseProperty({ type: [ProductStockStockItemDto] })
  public items: ProductStockStockItemDto[];
}
```

> [GitHub: libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.response.dto.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.response.dto.ts#L1-L29)

`@ApiResponseProperty` — единственный декоратор, как и
полагается для response-DTO. Снова: на стороне inventory-
microservice репозиторий (`IStockRepositoryPort.aggregateForProduct`)
возвращает уже готовый `ProductStockGetResponseDto`. По
ADR-016 этот же тип кэшируется через `IStockCachePort`. То
есть один **view-shape** живёт от персистенс-агрегации, через
кэш, до HTTP-response — это то ради чего вообще существует
projection-DTO.

### `IRetailOrderCreatedEvent` и `IInventoryStockLowEvent` — шестой суффикс

События — это **plain JSON в RabbitMQ**, и тут конвенция
радикально другая: интерфейс, никаких decorator'ов:

```typescript
// libs/contracts/retail/events/order-created.event.ts
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

> [GitHub: libs/contracts/retail/events/order-created.event.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/retail/events/order-created.event.ts#L1-L19)

```typescript
// libs/contracts/inventory/events/stock-low.event.ts
export interface IInventoryStockLowEvent extends ICorrelationPayload {
  productId: number;
  storageId: string;
  quantity: number;
  threshold: number;
  occurredAt: string;
}
```

> [GitHub: libs/contracts/inventory/events/stock-low.event.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/contracts/inventory/events/stock-low.event.ts#L1-L13)

Каждый event:

- расширяет `ICorrelationPayload` — wire-payload всегда
  несёт `correlationId` (см. [[routing-keys-and-contracts]]);
- несёт `occurredAt: string` (ISO-формат) — потребитель не
  доверяет broker-timestamp'у (`ADR-011 §5`);
- **plain interface**. Никакого `class` — events
  сериализуются через JSON, и любой class-identity на одной
  стороне теряется при `JSON.stringify`.

Это последняя вариация по направлению: **outbound к
**внешнему** subscriber'у**. Не путать с
`OrderCreatedEvent`-классом из `apps/retail-microservice/.../
domain/order.model.ts` — тот живёт в `domain/` и нужен только
для in-process dispatch'а через `pullDomainEvents`. Adapter
`OrderRabbitmqPublisher` строит `IRetailOrderCreatedEvent` из
доменного `OrderCreatedEvent` (см. [[notifier-port-and-adapters]]
для consumer-стороны).

## Связанные решения

- [[use-cases-vs-fat-services]] — что получает use-case на
  вход (command) и что отдаёт (response/view). Этот guide
  именует, тот объясняет, **зачем** use-case в принципе.
- [[notifier-port-and-adapters]] — где
  `IRetailOrderCreatedEvent` потребляется (в consumer'е
  notification-microservice'а).
- [[shared-libs-philosophy]] — почему DTO живут в
  `libs/contracts`, а не в каждом сервисе локально.
- [[mappers-and-repositories]] — DTO ≠ entity; mapping живёт
  в `infrastructure/persistence/`.
- [[entity-vs-domain-model]] — `@Entity()` нельзя ставить
  на response-DTO или event-interface; entity — отдельное.
- [[message-vs-event-patterns]] — почему `@MessagePattern`
  (RPC) и `@EventPattern` (events) — это два разных шаблона,
  и почему event-payload — всегда plain interface.
- [[routing-keys-and-contracts]] — пара
  `MicroserviceMessagePatternEnum` + `ROUTING_KEYS` плюс spec
  на их sync; именно она обеспечивает, что
  `RETAIL_ORDER_CREATED` enum-value и `'retail.order.created'`
  string-value согласованы.
- ADR-008 — wire-формат RMQ-routing-key'ов
  (`<service>.<aggregate>.<action>`).
- ADR-011 §5 — отказ от `DomainEvent<TId>`-subclass'ов в
  качестве wire-format.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| DTO (Data Transfer Object) | Шейп для переноса данных между слоями/сервисами. |
| Request DTO (`*.request.dto.ts`) | Inbound-класс для HTTP/RPC; несёт `class-validator`-decorator'ы и `@ApiProperty`. |
| Response DTO (`*.response.dto.ts`) | Outbound-класс; несёт `@ApiResponseProperty`; без validator'ов. |
| Command (`*.command.ts`) | Plain interface — write-вход application-слоя; ожидаемая форма для use-case. |
| Query (`*.query.ts`) | Plain interface — read-вход application-слоя; зарезервированный слот. |
| View (`*.view.ts`) | Plain interface — read-projection; зарезервированный слот. |
| Event (`*.event.ts`) | Plain interface — wire-формат cross-service-события. |
| `ICorrelationPayload` | `{ correlationId: string }` — расширяемый базовый интерфейс для всех wire-payload'ов. |
| `class-validator` | Lib с decorator'ами `@IsInt`, `@IsEmail` и т.д.; runtime-валидация через `ValidationPipe`. |
| `class-transformer` | Lib для конвертации plain→class и обратно; нужен для nested DTO с `@Type(() => X)`. |
| `@ApiProperty` | Декоратор `@nestjs/swagger` для **входящих** полей. |
| `@ApiResponseProperty` | Декоратор `@nestjs/swagger` для **исходящих** полей. |
| Wire-формат | Сериализованная форма payload'а на канале (JSON в RabbitMQ-сообщении). |
| Projection | DTO, форма которого не повторяет агрегат 1-к-1 — содержит JOIN-данные, rolled-up totals и т.д. |
| Reference table | Таблица, хранящая enum-значения с дополнительными полями (`name`, `color`). У нас `order_status`, `order_product_status`. |
| Structural subtyping | TypeScript-механика: тип «matched», если поля совпадают; без `implements`. |
| `OrderConfirmResponseDto` | Response DTO, играющий роль view (содержит JOIN-projection). |
| `IOrderCreatePayload` | RPC-payload retail.order.create; extends `ICorrelationPayload` + `OrderCreateDto`. |
| `IRetailOrderCreatedEvent` | Wire-payload события `retail.order.created`. |
| `OrderCreatedEvent` (domain) | Class из `domain/order.model.ts`; in-process dispatch через `pullDomainEvents`. |
| `*.types.ts` (легаси) | Старое имя для query-вида payload'а до миграции; функционально — query. |
| `*.dto.ts` (легаси) | Старое имя для request-DTO; для совместимости с `libs/contracts`-clients сохранено. |

> [!faq]- Проверь себя
> 1. `OrderCreateDto` содержит `@IsInt @IsPositive`, а
>    `OrderCreateResponseDto` — `@ApiResponseProperty` без
>    `class-validator`-decorator'ов. Почему такая асимметрия?
> 2. `IOrderCreatePayload extends ICorrelationPayload,
>    OrderCreateDto`. Что эта строка делает с точки зрения
>    TypeScript? Что бы случилось, если бы я попытался
>    инстанциировать `IOrderCreatePayload` через `new`?
> 3. Зачем в auth-модуле есть **и** `LoginRequestDto`, **и**
>    `ILoginCommand` — поля же совпадают?
> 4. `IRetailOrderCreatedEvent` — это interface, а
>    `OrderCreatedEvent` (в `apps/retail-microservice/.../
>    domain/`) — это class. Объясните, зачем нужны оба, и
>    что было бы, если бы мы публиковали class напрямую.
> 5. `*.view.ts` сегодня в проекте не материализованы.
>    Опишите, как должен выглядеть кейс, в котором
>    появилось бы первое `*.view.ts` — и почему сейчас он
>    не нужен.

## Что почитать дальше

- [`recommendation.md` §4 в репозитории](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L241-L273)
  — оригинальная конвенция о пяти суффиксах.
- [`recommendation.md` §5 в репозитории](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/architecture-migration-plan/parts/recommendation.md#L274-L289)
  — список pattern-to-avoid; «один DTO на всё» — третий пункт.
- [ADR-011 в репозитории](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/011-notifier-port-and-adapters.md)
  §5 — обоснование «event = plain interface, не
  `DomainEvent<TId>`-subclass».
- [Martin Fowler, «Data Transfer Object»](https://martinfowler.com/eaaCatalog/dataTransferObject.html)
  — каноническое определение.
- [Vaughn Vernon, «Implementing DDD» Ch. 5 — Value Objects + DTOs](https://www.informit.com/store/implementing-domain-driven-design-9780321834577)
  — разница между Value Object (domain) и DTO (transport).
- [NestJS Validation docs](https://docs.nestjs.com/techniques/validation)
  — как `ValidationPipe` + `class-validator` работают в
  reality; полезно для понимания, почему validator'ы — на
  request, не на response.
