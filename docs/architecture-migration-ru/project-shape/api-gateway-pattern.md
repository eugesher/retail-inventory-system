---
created: 2026-05-15
updated: 2026-05-15
tags: [retail-inventory-system, project-shape, gateway, http-edge]
status: review
related:
  - "[[nestjs-monorepo]]"
  - "[[microservices-split]]"
  - "[[shared-libs-philosophy]]"
  - "[[hexagonal-architecture]]"
---

# Паттерн API Gateway

> [!abstract] Кратко
> `apps/api-gateway/` — единственный сервис в системе с **открытым
> HTTP-портом**. У него ровно две роли: быть HTTP-edge для внешних
> клиентов и проводить аутентификацию + RBAC для каждого входящего
> запроса. Бизнес-логики у него почти нет: модули `retail/` и
> `inventory/` на стороне gateway — это **тонкие RPC-адаптеры**,
> перебрасывающие вызов в одноимённый микросервис. Единственный
> модуль с собственным persistence-state'ом — `auth/` (агрегат `User`).
> Контракт «`ClientProxy` живёт только в `infrastructure/messaging/*-rabbitmq.adapter.ts`»
> сформулирован в ADR-009.

## Проблема, которую решает

В микросервисной системе с RabbitMQ как seam'ом (см.
[[microservices-split]]) внешние HTTP-клиенты не могут говорить с
сервисами напрямую: у retail/inventory/notification нет HTTP-порта.
Кому-то нужно стоять на границе и переводить REST в RPC.

Простое решение: пусть каждый сервис откроет свой HTTP, а клиент сам
маршрутизируется. Это плохо по трём причинам:

- **Аутентификация размазывается.** Каждый сервис вынужден сам
  валидировать JWT, ходить за пользователем в БД, проверять роли. Это
  четыре копии одного и того же кода с гарантированной рассинхронизацией.
- **Транспорт-coupling в клиентах.** Веб- и мобильные клиенты узнают
  про существование retail/inventory как отдельных endpoint'ов и
  должны знать, кто за что отвечает.
- **CORS, rate limiting, OpenAPI — четырьмя комплектами.** Любая
  cross-cutting штука размазывается по сервисам, а пользователю
  видна как четыре несвязанных API.

Решение — **API Gateway**: один сервис стоит на границе системы,
говорит REST наружу и RPC внутрь. ADR-009 формализовал его layout
после миграции: per-module hexagonal, как и у настоящих микросервисов,
но с одним отличием — у двух из трёх модулей (`retail`, `inventory`)
**нет своего `domain/`**, потому что у gateway нет своей бизнес-модели
заказов или стоков. Он только проксирует.

## Концепция

### Две задачи и одна не-задача

Сразу зафиксируем границу ответственности:

| Что делает gateway                       | Что НЕ делает gateway              |
| ---------------------------------------- | ---------------------------------- |
| Принимает HTTP-запрос                    | Не хранит заказы / стоки           |
| Валидирует JWT через `JwtAuthGuard`      | Не реализует доменные инварианты   |
| Проверяет роли через `RolesGuard`        | Не транзакции над предметкой       |
| Конвертирует REST в RMQ-RPC              | Не обогащает доменные DTO          |
| Возвращает ошибки клиенту                | Не делает агрегацию данных         |
| Поддерживает OpenAPI/Swagger             | Не считает «бизнес»-метрики        |
| Хранит и обслуживает `User` в `auth/`    | Не хранит ничего, кроме `User`     |

Эта таблица — суть ADR-009: «gateway — это **transport + auth**, а не
business-сервис». Любая попытка добавить логику типа «если заказ на
сумму >X, отметить как премиум» в use-case gateway'я — нарушение,
которое ловится в код-ревью и в архитектурном линте.

### Per-module hexagonal — даже без домена

Gateway соблюдает тот же шаблон `domain/application/infrastructure/presentation/`
(см. [[hexagonal-architecture]]), что и микросервисы — за одним
исключением: **у модулей `retail/` и `inventory/` папки `domain/`
нет**. У них нет собственного агрегата; они проксируют RPC.

```
apps/api-gateway/src/modules/
├── auth/
│   ├── domain/          # User, RoleVO, UserRegistered, UserLoggedIn events
│   ├── application/     # ports + use-cases (Login, Refresh, Logout, Register, ValidateUser)
│   ├── infrastructure/  # persistence (UserEntity), jwt, argon2
│   └── presentation/    # /auth/login, /auth/refresh, /auth/logout, /auth/me
├── retail/
│   ├── application/     # ports (IRetailGatewayPort) + use-cases (CreateOrder, ConfirmOrder)
│   ├── infrastructure/  # messaging (RetailRabbitmqAdapter)
│   └── presentation/    # /api/order/*, pipes/OrderConfirmPipe
└── inventory/
    ├── application/     # ports (IInventoryGatewayPort) + use-cases (GetProductStock)
    ├── infrastructure/  # messaging (InventoryRabbitmqAdapter)
    └── presentation/    # /api/product/:id/stock
```

`auth/` — **единственный** модуль gateway'я с настоящим `domain/`. Он
имеет агрегат `User` (см. ADR-010, [[jwt-and-rbac]]) и владеет
state'ом — `User` живёт в MySQL, к которой gateway подключается
напрямую. Остальные модули — transport-only.

### `ClientProxy` живёт только в адаптерах

Главное правило ADR-009: **`ClientProxy` из `@nestjs/microservices`
импортируется только из `infrastructure/messaging/*-rabbitmq.adapter.ts`**.
Никакой контроллер, никакой use-case, никакая pipe не имеют права
держать `ClientProxy` напрямую.

До миграции это правило нарушалось: в gateway каждый per-action service
(`OrderCreateService`, `OrderConfirmService`, …) инжектил
`ClientProxy` и `client.send()`-ал. Никакого слоя порт/адаптер не
было; замена транспорта или мока в тестах требовала переписывать
половину сервисов.

После миграции (см. ADR-009):

| Слой                                  | С чем общается                                  | Какие импорты разрешены                                |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `presentation/` (controller)          | use-case (через DI-класс)                        | `@nestjs/common`, `@nestjs/swagger`, contracts          |
| `presentation/` (pipe)                | порт (через DI-символ)                           | `@nestjs/common`, contracts                             |
| `application/use-cases/`              | порт (через DI-символ)                           | `nestjs-pino`, contracts, app-shared                    |
| `application/ports/`                  | —                                               | только contracts и ddd-типы                             |
| `infrastructure/messaging/*-rabbitmq.adapter.ts` | `ClientProxy`                            | **здесь и только здесь** `@nestjs/microservices`        |
| `infrastructure/<svc>.module.ts`      | связывает `provide: <PORT>, useClass: <Adapter>` | `MicroserviceClient<Svc>Module` из `libs/messaging`     |

Запрет на прямой `ClientProxy` — это не стилистика, это правило
архитектурного линта (см. [[module-boundaries]]). `eslint-plugin-boundaries`
запрещает импорт `@nestjs/microservices`, `amqplib` и
`amqp-connection-manager` отовсюду, кроме `infrastructure/messaging/`.

### Зачем use-case, если он только проксирует

В первой итерации миграции была мысль: «у gateway нет домена, давайте
схлопнем use-case'ы и пусть контроллер инжектит порт напрямую». ADR-009
эту альтернативу рассмотрел и отверг.

Причины:

- **Единообразие layout-а.** Если gateway отличается от микросервисов
  на один слой, `eslint-plugin-boundaries` нужно писать двумя
  комплектами. Дешевле сохранить use-case-слой.
- **Логирование и трансляция ошибок.** Use-case делает
  `this.logger.assign({ correlationId })`, оборачивает `try/catch`
  и переводит RpcException в HTTPException через
  `throwRpcError`. Это та работа, которая в каждом контроллере
  быстро превратилась бы в копипасту.
- **Слот для auth-aware-логики.** Когда понадобится «обогатить запрос
  данными текущего пользователя перед RPC», эта логика естественно
  ложится в use-case, а не в контроллер.

Use-case у gateway получился **слим** — обычно 25–40 строк, в основном
log + try/catch + один вызов порта.

### Имена модулей — по downstream-сервису

Один тонкий момент из ADR-009: модули gateway'я называются **по
downstream-сервису**, а не по URL-префиксу:

- `modules/retail/` — то, что проксирует в `retail-microservice`.
  Public URL — `/api/order/...` (потому что это «заказы»).
- `modules/inventory/` — то, что проксирует в `inventory-microservice`.
  Public URL — `/api/product/:productId/stock`.

Альтернативой было «называть по URL» (`modules/order/`,
`modules/product/`). Это сразу проигрывает: URL — деталь презентации,
она может поменяться. **Bounded context** на той стороне — то, что
не меняется. Layout gateway'я отзеркаливает структуру системы, а не
её URL-карту.

## Применение в проекте

### Bootstrap

```typescript
// apps/api-gateway/src/main.ts
import '@retail-inventory-system/observability/tracer';

import { ValidationPipe } from '@nestjs/common';
// ...
((): void => {
  const logger = new PinoLogger(new LoggerModuleConfig(AppNameEnum.API_GATEWAY));
  void (async (): Promise<void> => {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    const configService = app.get(ConfigService);
    const apiPrefix = configService.get<string>('API_GATEWAY_PREFIX')!;
    const port = configService.get<number>('API_GATEWAY_PORT')!;
    // ...
    app.setGlobalPrefix(apiPrefix);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    // ... Scalar OpenAPI viewer
    await app.listen(port);
  })().catch(/* ... */);
})();
```

> [GitHub: apps/api-gateway/src/main.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/main.ts#L1-L49)

Три отличия от микросервисных `main.ts` (см. [[microservices-split]]):

- `NestFactory.create(AppModule, ...)` (HTTP), а не
  `createMicroservice(...)` (RMQ).
- `app.useGlobalPipes(new ValidationPipe(...))` —
  валидация всех HTTP-DTO через `class-validator`.
- Scalar OpenAPI viewer на `/api/reference` (опционально, по флагу
  `API_GATEWAY_USE_API_REFERENCE`).

### Глобальные guards и CorrelationMiddleware

`AppModule` объявляет **два глобальных guard'а** и одно middleware:

```typescript
// apps/api-gateway/src/app/app.module.ts
@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.API_GATEWAY)),
    DatabaseModule.forRoot([UserEntity]),
    AuthModule,
    RetailModule,
    InventoryModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
```

> [GitHub: apps/api-gateway/src/app/app.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/app/app.module.ts#L1-L36)

Что здесь происходит:

- `DatabaseModule.forRoot([UserEntity])` — gateway подключается к
  MySQL **только** для модуля `auth`. Никакая другая сущность здесь
  не зарегистрирована.
- `JwtAuthGuard` — глобальный. Каждый endpoint аутентифицирован по
  умолчанию; чтобы сделать публичный, нужен декоратор `@Public()`.
- `RolesGuard` — глобальный. Декоратор `@Roles(RoleEnum.X)` объявляет,
  кто допускается; без декоратора пускают всех аутентифицированных.
- `CorrelationMiddleware` — на каждый `path`. Извлекает или
  генерирует `x-correlation-id`, кладёт в request, прокидывает в
  каждый последующий RPC. См. [[trace-log-correlation]].

### Один типичный flow — `POST /api/order`

```typescript
// apps/api-gateway/src/modules/retail/presentation/order.controller.ts
@ApiTags('Order')
@ApiBearerAuth()
@Roles(RoleEnum.CUSTOMER, RoleEnum.ADMIN)
@Controller('order')
export class OrderController {
  constructor(
    private readonly createOrderUseCase: CreateOrderUseCase,
    private readonly confirmOrderUseCase: ConfirmOrderUseCase,
  ) {}

  @Post()
  public async createOrder(
    @Body() dto: OrderCreateDto,
    @CorrelationId() correlationId: string,
  ): Promise<OrderCreateResponseDto> {
    return this.createOrderUseCase.execute(dto, correlationId);
  }
  // ...
}
```

> [GitHub: apps/api-gateway/src/modules/retail/presentation/order.controller.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/retail/presentation/order.controller.ts#L1-L53)

Контроллер пересекает три DI-границы:

1. Глобальный `JwtAuthGuard` (из `libs/auth`) проверяет access-token.
2. Глобальный `RolesGuard` сверяет роль с `@Roles(...)`.
3. `ValidationPipe` валидирует `OrderCreateDto` (`class-validator`).

И потом передаёт управление use-case'у.

```typescript
// apps/api-gateway/src/modules/retail/application/use-cases/create-order.use-case.ts
@Injectable()
export class CreateOrderUseCase {
  constructor(
    @Inject(RETAIL_GATEWAY_PORT)
    private readonly retailGateway: IRetailGatewayPort,
    @InjectPinoLogger(CreateOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(dto: OrderCreateDto, correlationId: string): Promise<OrderCreateResponseDto> {
    this.logger.assign({ correlationId });
    try {
      this.logger.info(
        { customerId: dto.customerId, productCount: dto.products.length },
        'Order creation in progress',
      );
      const order = await this.retailGateway.createOrder(dto, correlationId);
      // ...
      return order;
    } catch (error) {
      this.logger.error(error, 'Error creating order');
      throwRpcError(error);
    }
  }
}
```

> [GitHub: apps/api-gateway/src/modules/retail/application/use-cases/create-order.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/retail/application/use-cases/create-order.use-case.ts#L1-L45)

Use-case **не знает**, что за `RETAIL_GATEWAY_PORT` стоит RabbitMQ. Он
инжектит **символ** `RETAIL_GATEWAY_PORT` и работает с интерфейсом
`IRetailGatewayPort`. В тестах его подставить — однострочник.

```typescript
// apps/api-gateway/src/modules/retail/application/ports/retail-gateway.port.ts
export const RETAIL_GATEWAY_PORT = Symbol('RETAIL_GATEWAY_PORT');

export interface IRetailGatewayPort {
  createOrder(dto: OrderCreateDto, correlationId: string): Promise<OrderCreateResponseDto>;
  confirmOrder(id: number, correlationId: string): Promise<OrderConfirmResponseDto>;
  // No correlationId here — `RETAIL_ORDER_GET` carries only the numeric id on the
  // wire today (ADR-008).
  getOrderStatus(id: number): Promise<{ statusId: OrderStatusEnum } | null>;
}
```

> [GitHub: apps/api-gateway/src/modules/retail/application/ports/retail-gateway.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/retail/application/ports/retail-gateway.port.ts#L1-L17)

И единственный класс, который знает, что между gateway и retail-микросервисом
лежит очередь `retail_queue`:

```typescript
// apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts
@Injectable()
export class RetailRabbitmqAdapter implements IRetailGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async createOrder(dto: OrderCreateDto, correlationId: string): Promise<OrderCreateResponseDto> {
    return firstValueFrom(
      this.client.send<OrderCreateResponseDto, IOrderCreatePayload>(
        ROUTING_KEYS.RETAIL_ORDER_CREATE,
        { ...dto, correlationId },
      ),
    );
  }
  // ...
}
```

> [GitHub: apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts#L1-L54)

Здесь и только здесь:

- Импорт `ClientProxy` из `@nestjs/microservices`.
- Использование `ROUTING_KEYS.RETAIL_ORDER_CREATE` (dotted-формат из
  `libs/messaging`).
- Обёртка `firstValueFrom(...)` над rxjs-Observable — потому что
  use-case ждёт `Promise<...>`.

Composition root модуля связывает порт с адаптером **на одной строке**:

```typescript
// apps/api-gateway/src/modules/retail/infrastructure/retail.module.ts
@Module({
  imports: [MicroserviceClientRetailModule],
  controllers: [OrderController],
  providers: [
    OrderConfirmPipe,
    ConfirmOrderUseCase,
    CreateOrderUseCase,
    { provide: RETAIL_GATEWAY_PORT, useClass: RetailRabbitmqAdapter },
  ],
})
export class RetailModule {}
```

> [GitHub: apps/api-gateway/src/modules/retail/infrastructure/retail.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/retail/infrastructure/retail.module.ts#L1-L21)

Чтобы поменять транспорт (например, перевести retail на gRPC) —
переписать ровно один класс `RetailRabbitmqAdapter`. Контроллер, pipe,
use-case остаются нетронутыми.

### Pipe тоже инжектит порт, а не `ClientProxy`

ADR-009 уделил один пункт **pipe**'ам. До миграции `OrderConfirmPipe`
держал `ClientProxy` и сам отправлял `RETAIL_ORDER_GET`. Это «утечка»:
pipe — это presentation-слой, и он не должен знать про транспорт.

После миграции pipe инжектит **тот же `RETAIL_GATEWAY_PORT`**, что и
use-case:

```typescript
// apps/api-gateway/src/modules/retail/presentation/pipes/order-confirm.pipe.ts
@Injectable()
export class OrderConfirmPipe implements PipeTransform<string, Promise<number>> {
  constructor(
    @Inject(RETAIL_GATEWAY_PORT)
    private readonly retailGateway: IRetailGatewayPort,
  ) {}

  public async transform(param: string): Promise<number> {
    const id = Number(param);
    if (isNaN(id)) throw new BadRequestException(/* ... */);

    const order = await this.retailGateway.getOrderStatus(id);
    if (!order) throw new NotFoundException(`Order #${id} not found`);
    if (order.statusId !== OrderStatusEnum.PENDING) {
      throw new BadRequestException(/* ... */);
    }
    return id;
  }
}
```

> [GitHub: apps/api-gateway/src/modules/retail/presentation/pipes/order-confirm.pipe.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/retail/presentation/pipes/order-confirm.pipe.ts#L1-L42)

Pipe загружает текущий status заказа (третий метод порта —
`getOrderStatus`), валидирует переход status'а и пропускает дальше.
Никакого `ClientProxy`, никаких `client.send(...)`. Поскольку pipe
выполняется до контроллера, без gateway-side-проверки невалидный
запрос пошёл бы в retail-микросервис и упал бы там — оставив worker'у
лишнюю работу.

### Авторизация: `JwtAuthGuard` + `@Public` + `@Roles`

`@Roles(RoleEnum.CUSTOMER, RoleEnum.ADMIN)` на классе контроллера —
это объявление политики: endpoint доступен только пользователям с
ролью CUSTOMER или ADMIN. Дефолт «все авторизованы» сменяется на
«только эти роли». Если пользователь анонимный — `JwtAuthGuard` его
завернёт 401. Если аутентифицирован, но не с той ролью — `RolesGuard`
вернёт 403.

Подробности механики — в [[jwt-and-rbac]]. Здесь важна одна
gateway-specific деталь: **`auth/` — единственный модуль gateway'я с
DB-state'ом**. Этот state — `User`. Все остальные state'ы (заказы,
стоки) — за пределами процесса, в retail/inventory.

## Связанные решения

- [[nestjs-monorepo]] — почему gateway живёт в том же репозитории, что
  и три микросервиса, и как они собираются одной командой.
- [[microservices-split]] — что находится по другую сторону RPC,
  который выпускает gateway.
- [[shared-libs-philosophy]] — какие именно libs gateway импортирует:
  `auth`, `contracts`, `messaging`, `observability`, `config`,
  `database`.
- [[hexagonal-architecture]] — внутренний layout, который gateway
  сохраняет, даже не имея «настоящего» домена в двух модулях из трёх.
- [[jwt-and-rbac]] — что делает `auth/` модуль — единственный модуль
  gateway'я с собственным агрегатом.

## Глоссарий

| Термин (EN)             | Перевод / пояснение (RU)                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Gateway             | Сервис, стоящий на границе системы. Принимает HTTP, делает auth, переводит запрос в RPC к нужному микросервису.                                                                                                                                       |
| HTTP edge               | «Внешняя кромка» — единственное место, куда могут подключаться внешние клиенты. В нашей системе — `apps/api-gateway/`.                                                                                                                                |
| `ClientProxy`           | Класс из `@nestjs/microservices` для отправки RPC/event'ов в очередь. У gateway'я живёт **только** внутри `infrastructure/messaging/<svc>-rabbitmq.adapter.ts`.                                                                                       |
| `MicroserviceClient<Svc>Module` | Модуль из `libs/messaging` для регистрации `ClientProxy` под конкретным DI-токеном (`RETAIL_MICROSERVICE`, `INVENTORY_MICROSERVICE`, `NOTIFICATION_MICROSERVICE`).                                                                            |
| `firstValueFrom`        | Утилита rxjs, превращающая Observable в Promise. Используется в каждом адаптере, поскольку `ClientProxy.send/emit` возвращают Observable, а use-case ждёт Promise.                                                                                  |
| Global guard            | `JwtAuthGuard` / `RolesGuard` зарегистрированы через `APP_GUARD` — применяются ко **всем** route'ам. Отказаться можно декоратором `@Public()` или иной ролевой политикой через `@Roles(...)`.                                                          |
| `@Public()`             | Декоратор из `libs/auth`, помечающий endpoint как доступный без аутентификации (например, `/auth/login`, `/auth/refresh`).                                                                                                                            |
| `@Roles(...)`           | Декоратор из `libs/auth`, ограничивающий endpoint списком ролей (`RoleEnum.CUSTOMER`, `RoleEnum.ADMIN`).                                                                                                                                              |
| Validation pipe         | Глобальный `ValidationPipe` с `{ whitelist, transform, forbidNonWhitelisted }` — валидирует все DTO через `class-validator` и удаляет лишние поля.                                                                                                    |
| Correlation ID          | `x-correlation-id` HTTP-header. `CorrelationMiddleware` извлекает или генерирует его, кладёт в request-scope; use-case прокидывает в RMQ-payload как `correlationId`. Дальше его подхватывает Pino и Jaeger.                                          |
| Scalar OpenAPI viewer   | Альтернатива Swagger UI. Монтируется на `/api/reference`, если `API_GATEWAY_USE_API_REFERENCE=true`. Документ создаётся через `@nestjs/swagger` `SwaggerModule.createDocument`.                                                                       |

## Что почитать дальше

- [ADR-009](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/009-port-adapter-at-the-gateway.md)
  — фиксация per-module hexagonal на gateway, выбор имён модулей,
  правило «`ClientProxy` живёт только в адаптерах».
- [ADR-010](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/010-jwt-rbac-at-the-gateway.md)
  — JWT + RBAC, единственный модуль gateway'я с настоящим `domain/`.
- Sam Newman — *Building Microservices* (O'Reilly, 2-е изд., 2021),
  глава 4 «Communication Styles» — обоснование gateway-паттерна в
  микросервисных системах.
- Chris Richardson — *Microservices Patterns* (Manning, 2018),
  глава 8 «External API patterns» — варианты gateway-паттернов
  (BFF vs single gateway).

> [!faq]- Проверь себя
>
> 1. Сколько модулей сегодня у gateway'я? У какого из них есть свой
>    `domain/` и почему именно у него?
> 2. Где живёт `ClientProxy` в коде gateway'я? Какой механизм
>    запрещает поднять его в use-case или контроллер?
> 3. Почему `OrderConfirmPipe` инжектит `RETAIL_GATEWAY_PORT`, а не
>    `ClientProxy`? Что мы выиграли, прогнав пайп через порт?
> 4. Если завтра retail-микросервис переедет на gRPC, что нужно
>    изменить в коде gateway'я? Сколько файлов? Почему так мало?
> 5. Почему модуль на стороне gateway называется `retail/`, а не
>    `order/` (как HTTP-префикс)? Чему это соответствует с точки
>    зрения bounded-контекстов?
