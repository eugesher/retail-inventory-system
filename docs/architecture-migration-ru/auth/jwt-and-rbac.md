---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, auth, jwt, rbac, security]
status: final
related:
  - "[[auth-stack-overview]]"
  - "[[lib-nestjs-passport]]"
  - "[[lib-passport]]"
  - "[[lib-passport-jwt]]"
  - "[[lib-nestjs-jwt]]"
  - "[[lib-argon2]]"
  - "[[hexagonal-architecture]]"
  - "[[api-gateway-pattern]]"
  - "[[shared-libs-philosophy]]"
  - "[[entity-vs-domain-model]]"
---

# JWT и RBAC на gateway

> [!abstract] Кратко
> Аутентификация в Retail Inventory System построена на двух
> stateless JWT (access + refresh, HS256, два независимых
> секрета), пароли хранятся как argon2id-хэши, refresh-токен
> **rotated** на каждом успешном refresh с защитой от reuse, а
> авторизация — RBAC через два глобальных `APP_GUARD`
> (`JwtAuthGuard` и `RolesGuard`). Все маршруты по умолчанию
> защищены; явный `@Public()` — это единственный путь
> сделать endpoint открытым. `User` живёт в `modules/auth/`
> API-gateway'я и является **единственным** gateway-модулем с
> настоящим `domain/`. Все решения — в [ADR-010](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/010-jwt-rbac-at-the-gateway.md).

## Проблема, которую решает

До task-06 в репозитории **вообще не было аутентификации**:
ни одной строчки `@nestjs/jwt`, ни `passport`-стека, ни
`auth/`-папки, ни таблицы `user` в MySQL. Любой клиент мог
дёргать `POST /api/order` или `GET /api/product/:id/stock`
без какой-либо проверки личности. Audit baseline это допускал
(`_carryover-01.md` фиксирует «no auth implementation» как
известный gap), но для портфельного релиза проект должен
закрыть и identification ('кто это?'), и authorization
('что ему позволено?').

Цель — добавить и то и другое, не превращая четыре микросервиса
в распределённый session store, и не подключая внешний IdP
(Auth0, Cognito, Keycloak), который занял бы больше операционного
веса, чем вся миграция.

## Концепция

### Три отдельных вопроса: identification, authentication, authorization

Прежде чем разбирать JWT, важно отделить три понятия, которые в
обиходе часто склеивают в одно слово «авторизация»:

- **Identification.** Кто этот запрос утверждает, что он? У
  нас — `sub` (subject) поля access-JWT: UUID пользователя.
- **Authentication.** Доказательство, что утверждение правда.
  У нас — подпись JWT секретом `JWT_ACCESS_SECRET`: только
  gateway мог её поставить, потому что только gateway знает
  секрет.
- **Authorization.** Имеет ли этот пользователь право на
  это действие. У нас — `roles[]` из payload'а сверяется со
  списком `@Roles(...)` через `RolesGuard`.

JWT решает первые два пункта вместе. RBAC — третий. Поэтому
гид рассматривает их как одну тему: они работают в паре, но
концептуально это разные слои.

### Почему JWT, а не session cookies

Server-side sessions требуют **общего session store** между
всеми сервисами, которым нужно знать, кто запросил. В нашей
архитектуре это значит, что каждый микросервис (`retail`,
`inventory`, `notification`) должен лезть в Redis за
session-blob'ом **прежде, чем** обработать запрос. Это создаёт:

1. Новый SPOF (Redis для auth уже не «кэш — best-effort», а
   load-bearing).
2. Сетевой hop на каждом hot-path вызове.
3. Связку «все сервисы общаются с одним хранилищем
   принципалов», что для микросервисной архитектуры — анти-
   паттерн.

JWT отдают gateway'ю короткоживущий bearer-token, который
любой downstream-сервис может проверить **offline** против
того же секрета (или public key в RS256-варианте). Нет общего
store, нет SPOF, нет hop'а. Tradeoff — токен нельзя отозвать
до истечения срока (15 минут у нас); это покрыто короткой
жизнью access-токена и rotation'ом refresh'а.

### HS256, два секрета, и почему

Мы подписываем оба JWT'а симметричным **HS256** (HMAC-SHA-256),
а не RS256 (RSA с парой ключей):

- HS256 — это один секрет: `JWT_ACCESS_SECRET` для access-JWT,
  `JWT_REFRESH_SECRET` для refresh-JWT. Подписать и проверить
  могут все, у кого есть секрет.
- RS256 — это пара: gateway подписывает приватным ключом,
  downstream-сервисы проверяют публичным. Это удобно, когда
  набор «подписывающих» и «проверяющих» сильно разный, или
  когда нужно ротировать ключи без распространения нового
  приватного.

Для портфельного проекта без HSM/Vault разница между «одним
секретом» и «парой ключей» — это операционная сложность без
дохода: оба варианта требуют доставки материала во все
сервисы. HS256 проще и меньше moving parts. ADR-010 §6
оставляет переход на RS256 как future-option, если/когда в
архитектуру попадёт инфраструктура для распределения
ключей.

Два **разных** секрета (один для access, один для refresh) —
это не косметика: если access-секрет утечёт через лог,
refresh-токены не становятся подделываемыми. Joi-schema в
`libs/config/config-module.config.ts` отказывается стартовать,
если они совпадают.

### argon2id, а не bcrypt

`argon2id` — победитель Password Hashing Competition и
рекомендация OWASP по умолчанию для новых приложений. Он
**memory-hard**: для брутфорса нужен не только CPU, но и
много памяти, что обнуляет преимущества GPU/FPGA-фермы. Также
он гибридный — комбинирует устойчивость к side-channel-атакам
(`argon2i`) и устойчивость к параллельному брутфорсу
(`argon2d`).

`bcrypt` — это «не сломано, но устарело»: проверенный годами
алгоритм, но не memory-hard, и с встроенным ограничением 72
байта на пароль. Поскольку наш auth — greenfield (нет legacy
hash'ей, с которых нужно мигрировать), причин выбирать
старый примитив нет. Подробности параметров и почему у нас
именно OWASP-2024 defaults — в [[lib-argon2]].

### Refresh-token rotation с reuse-detection

Самая интересная (и самая часто-неправильно-реализованная)
часть auth-стека — rotation. Базовая идея:

- Access-токен короткий (15 мин), его компрометация —
  ограниченное окно.
- Refresh-токен длинный (7 дней) и сам по себе — атакующий
  актив. Если его украдут, атакующий может выпускать новые
  access-токены, пока пользователь не сделает logout.
- **Rotation** означает: при каждом `POST /auth/refresh`
  выпускается **новый** refresh, а старый — недействителен.
- **Reuse-detection**: если кто-то попытается воспользоваться
  **уже обменянным** refresh'ем, это сигнал, что либо
  легитимный пользователь забыл, либо токен украли. В обоих
  случаях правильная реакция — обнулить live-refresh-hash на
  user-row'е, чтобы и атакующий, и легитимный пользователь
  потеряли сессию. Легитимный пользователь сделает login
  заново; атакующий — fail.

Хэш живёт на user-row'е (`refresh_token_hash` — `varchar(255)`,
nullable). Это **argon2-хэш самого refresh-токена**: даже если
БД утечёт, атакующий не получит реигрываемые refresh'и.
Argon2-verify добавляет ~5–10 мс на каждый refresh, что для
операции «раз в 15 минут» вполне приемлемо.

### RBAC «всё закрыто по умолчанию»

В большинстве проектов авторизация устроена так: декоратор
`@AuthRequired()` (или какой-нибудь массив `protectedRoutes`)
покрывает endpoints, которые «надо защитить». Это означает,
что **новый endpoint** — открытый, пока не вспомнили его
явно добавить. Это failure-mode настолько частый, что у него
есть имя — *broken access control* (OWASP A01:2021, top-1).

Мы инвертируем умолчание: глобальные `APP_GUARD`-провайдеры
делают **все** маршруты защищёнными. Чтобы открыть endpoint
(`POST /auth/login`, `POST /auth/refresh`), нужно явно
повесить `@Public()`. Эта инверсия по умолчанию даёт нам
fail-closed: если кто-то добавил новый controller и забыл
аннотации — он 401, а не открыт.

`@Roles(RoleEnum.X, ...)` — отдельный слой поверх. Если на
маршруте нет `@Roles`, `RolesGuard` пропускает (any
authenticated user). Если есть — пользователь должен иметь
хотя бы одну из перечисленных ролей.

### Где живёт `User` — и почему он один такой на gateway'е

`User` — это **aggregate**, у него есть инварианты, поведение
(rotation, password validation), domain-events, и он не равен
db-row'у. Это делает `modules/auth/` единственным gateway-
модулем с настоящим `domain/`-слоем. Сравнительные другие
модули gateway'я — `modules/retail/`, `modules/inventory/` —
это pass-through-обёртки над RMQ-адаптерами; они не владеют
состоянием, а домен живёт в микросервисах. См.
[[entity-vs-domain-model]] и [[api-gateway-pattern]].

Альтернативы, которые рассматривались (и были отклонены) —
ADR-010 §4:

- **Отдельный `user-microservice`.** Каждый authenticated
  запрос пошёл бы через RMQ-hop из gateway'я в user-сервис
  для `validate()`-callback'а JWT-strategy. Latency-hit
  огромный, deployment-surface растёт, profit — нулевой.
- **`User` живёт в retail-микросервисе рядом с `customer`.**
  Но `customer` — это buyer, а не authenticated principal:
  будущий store-manager не имеет `customer`-row'а, но логиниться
  должен. Связывать их сейчас — закладывать ту же миграцию,
  что мы сейчас делаем, повторно.

### Какие role-комбинации сейчас seed'ятся

Из ADR-010 и `scripts/test-db-seed.ts`:

| Email | Пароль (dev) | Роли |
|-------|--------------|------|
| `admin@example.com` | `admin1234` | `admin`, `customer` |
| `customer@example.com` | `customer1234` | `customer` |

Admin **наследует** customer-доступ не через role-иерархию, а
тем, что обе роли проставлены в seed'е. У `RolesGuard` нет
понятия «admin > customer» — это сознательное упрощение
(ADR-010 §5): добавить «иерархию» можно потом, она не
load-bearing для текущих use-case'ов, а её отсутствие делает
правила очевидно прозрачными.

## Применение в проекте

### Регистрация глобальных guard'ов в `app.module.ts`

Самое важное решение — «все маршруты защищены по умолчанию» —
живёт в семи строчках:

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

> [GitHub: apps/api-gateway/src/app/app.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/app/app.module.ts#L17-L35)

`APP_GUARD` — это специальный Nest-токен, на который можно
подвесить guard, и он будет применён **глобально** ко всем
controller'ам. Порядок важен: `JwtAuthGuard` идёт первым,
`RolesGuard` — вторым. Это значит: сначала проверяется
аутентификация (есть ли валидный JWT?), и только если она
прошла — авторизация (есть ли нужная роль?).

Также здесь — первая (и единственная) на gateway'е регистрация
`DatabaseModule.forRoot([UserEntity])`: до task-06 у gateway'я
вообще не было TypeORM-подключения. ADR-010 §«Consequences»
явно фиксирует, что это сознательное архитектурное
изменение.

### `libs/auth` — framework-glue, без app-state

```typescript
// libs/auth/auth.module.ts
@Module({})
export class AuthModule {
  public static forRootAsync(options: IAuthModuleOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.registerAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => ({
            secret: configService.get<string>('JWT_ACCESS_SECRET'),
            signOptions: {
              expiresIn: configService.get<string>(
                'JWT_ACCESS_EXPIRES_IN',
              ) as JwtSignOptions['expiresIn'],
            },
          }),
        }),
        ...(options.imports ?? []),
      ],
      providers: [JwtStrategy, JwtAuthGuard, RolesGuard, ...(options.providers ?? [])],
      exports: [JwtModule, PassportModule, JwtAuthGuard, RolesGuard, ...(options.exports ?? [])],
    };
  }
}
```

> [GitHub: libs/auth/auth.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/auth.module.ts#L19-L45)

`forRootAsync` — это Nest-конвенция: «модуль, который сам
конфигурируется ConfigService'ом и принимает app-specific
дополнения». Что здесь важно концептуально:

1. `libs/auth` **не знает** ни про `User`, ни про `UserEntity`,
   ни про TypeORM. Это framework-glue над `passport`,
   `@nestjs/passport` и `@nestjs/jwt`. Подробнее
   [[shared-libs-philosophy]].
2. Точкой расширения служит `IAuthModuleOptions` — структура
   с `imports`, `providers`, `exports`. Gateway передаёт через
   неё **biding `AUTH_USER_VALIDATOR` → `ValidateUserUseCase`**
   и репозиторий, который этот use case нуждается.
3. Регистрация **global: true** означает, что после одного
   импорта `AuthModule.forRootAsync(...)` в `app.module.ts`
   `JwtAuthGuard` и `RolesGuard` доступны везде — но
   фактически они применяются только потому, что
   `app.module.ts` их явно регистрирует через `APP_GUARD`.

### Порт `AUTH_USER_VALIDATOR` — стык libs/auth и host-app

```typescript
// libs/auth/auth-user-validator.port.ts
import { ICurrentUser, IJwtAccessPayload } from '@retail-inventory-system/contracts';

export const AUTH_USER_VALIDATOR = Symbol('AUTH_USER_VALIDATOR');

// Apps wire a binding for this token under their own auth module so the
// shared `JwtStrategy` can resolve a request user without knowing how the
// app stores or revokes accounts.
export interface IAuthUserValidator {
  validate(payload: IJwtAccessPayload): Promise<ICurrentUser>;
}
```

> [GitHub: libs/auth/auth-user-validator.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/auth-user-validator.port.ts#L1-L10)

Это **порт** в hexagonal-смысле ([[hexagonal-architecture]]):
интерфейс на стороне domain-/application-кода, который lib
требует, но не реализует. Без этого порта `JwtStrategy` пришлось
бы:

- либо знать про TypeORM/`UserEntity` (что нарушает
  layering — нельзя ставить persistence-зависимости в lib);
- либо принимать generic-параметр и навязывать его всем consumer'ам.

С портом — `libs/auth` стабильна; app может произвольно
менять, как именно она «достаёт пользователя».

### `JwtStrategy.validate` — единственная точка контакта lib с домен-стейтом

```typescript
// libs/auth/jwt.strategy.ts
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    @Inject(AUTH_USER_VALIDATOR) private readonly userValidator: IAuthUserValidator,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET')!,
    });
  }

  // Passport-jwt has already verified the signature and expiry by the time
  // this runs. The validator port lets the host app reject revoked or
  // soft-deleted accounts without leaking persistence into libs/auth.
  public async validate(payload: IJwtAccessPayload): Promise<ICurrentUser> {
    return this.userValidator.validate(payload);
  }
}
```

> [GitHub: libs/auth/jwt.strategy.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/jwt.strategy.ts#L10-L29)

К моменту, когда `validate()` вызывается, `passport-jwt` (см.
[[lib-passport-jwt]]) уже:

- извлёк токен из `Authorization: Bearer …`;
- проверил подпись по `JWT_ACCESS_SECRET`;
- проверил `exp` (поскольку `ignoreExpiration: false`).

`validate()` решает оставшийся вопрос: «соответствует ли
payload **живому** пользователю?». В gateway'е этот вопрос
решает `ValidateUserUseCase`:

```typescript
// apps/api-gateway/src/modules/auth/application/use-cases/validate-user.use-case.ts
@Injectable()
export class ValidateUserUseCase implements IAuthUserValidator {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepositoryPort) {}

  public async validate(payload: IJwtAccessPayload): Promise<ICurrentUser> {
    const user = await this.users.findById(payload.sub);
    if (!user?.isActive) {
      throw new UnauthorizedException('Account is no longer active');
    }

    return {
      id: user.id,
      email: user.email,
      roles: user.roles.map((role) => role.value),
    };
  }
}
```

> [GitHub: apps/api-gateway/src/modules/auth/application/use-cases/validate-user.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/application/use-cases/validate-user.use-case.ts#L1-L24)

Здесь решается, что:

- Soft-deleted (`deletedAt !== null`) пользователь — 401, даже
  если у него валидный JWT в кармане. Это даёт нам канал
  отзыва: пометил пользователя `deletedAt = NOW()` → его JWT
  перестанет работать на следующем запросе.
- Если в payload `sub` ссылается на несуществующего user'а —
  тоже 401.
- В `req.user` кладётся `ICurrentUser` (id, email, roles) —
  именно эту форму потом достаёт `@CurrentUser()`-декоратор.

### `JwtAuthGuard` — `@Public()` short-circuit

```typescript
// libs/auth/jwt-auth.guard.ts
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  public override canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
```

> [GitHub: libs/auth/jwt-auth.guard.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/jwt-auth.guard.ts#L11-L31)

Тут две детали стоит выделить:

1. `getAllAndOverride([handler, class])` — Reflector ищет
   `IS_PUBLIC_KEY` сначала на конкретном методе, потом на
   уровне класса. Значит `@Public()` можно повесить на **весь
   controller** (например, на `HealthController`), и все его
   методы будут открытыми; или только на конкретный метод.
2. Если public — `return true` (не запускаем passport-стек,
   `req.user` останется `undefined`). Иначе — `super.canActivate`
   делает всю работу: достаёт стратегию `'jwt'` (мы её
   назвали так в `PassportStrategy(Strategy, 'jwt')`),
   запускает passport, который запустит passport-jwt, который
   запустит `validate()`.

### `RolesGuard` — отдельный пас

```typescript
// libs/auth/roles.guard.ts
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<RoleEnum[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request: IRequestWithUser = context.switchToHttp().getRequest<IRequestWithUser>();
    const user = request.user;

    if (!user || !Array.isArray(user.roles)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const hasRole = requiredRoles.some((role) => user.roles.includes(role));
    if (!hasRole) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
```

> [GitHub: libs/auth/roles.guard.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/roles.guard.ts#L13-L41)

`RolesGuard` бежит **после** `JwtAuthGuard` (потому что в
`app.module.ts` они зарегистрированы в этом порядке), значит
`request.user` либо уже выставлен (валидный JWT), либо запрос
уже завернут на 401 в `JwtAuthGuard`. Если `@Roles(...)` нет
— guard молча пропускает (это и означает «требуется только
аутентификация»). Если есть — `some()`-проверка, при провале
— **403 Forbidden** (а не 401). Это правильный код: «я знаю,
кто ты, но тебе нельзя».

### `@Public()`, `@Roles(...)`, `@CurrentUser()` на практике

`POST /auth/login` и `POST /auth/refresh` — единственные
`@Public()` endpoint'ы:

```typescript
// apps/api-gateway/src/modules/auth/presentation/auth.controller.ts
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate with email + password' })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  public async login(@Body() dto: LoginRequestDto): Promise<TokenResponseDto> {
    const result = await this.loginUseCase.execute(dto);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    };
  }
```

> [GitHub: apps/api-gateway/src/modules/auth/presentation/auth.controller.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/presentation/auth.controller.ts#L30-L67)

`/auth/me` и `/auth/logout` (на том же controller'е) уже
**не** `@Public()` — они унаследуют дефолт-защиту. И они
тянут `@CurrentUser()`:

```typescript
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated user' })
  @ApiOkResponse({ type: CurrentUserResponseDto })
  public me(@CurrentUser() user: ICurrentUser): CurrentUserResponseDto {
    return { id: user.id, email: user.email, roles: user.roles };
  }
```

`@CurrentUser()` — это `createParamDecorator`, который просто
читает `request.user`:

```typescript
// libs/auth/current-user.decorator.ts
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ICurrentUser | undefined => {
    const request: IRequestWithUser = ctx.switchToHttp().getRequest<IRequestWithUser>();
    return request.user;
  },
);
```

> [GitHub: libs/auth/current-user.decorator.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/current-user.decorator.ts#L1-L14)

`request.user` к этому моменту уже выставлен `JwtStrategy.validate`
(через passport под капотом). Если бы маршрут был `@Public()`,
`user` бы оказался `undefined` — для public-маршрутов
`@CurrentUser()` не имеет смысла.

### Routes с `@Roles(...)`-аннотацией

На стороне retail/inventory gateway-модулей роли проставлены
на **уровне класса**:

```typescript
// apps/api-gateway/src/modules/retail/presentation/order.controller.ts
@ApiTags('Order')
@ApiBearerAuth()
@Roles(RoleEnum.CUSTOMER, RoleEnum.ADMIN)
@Controller('order')
export class OrderController { /* ... */ }
```

> [GitHub: apps/api-gateway/src/modules/retail/presentation/order.controller.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/retail/presentation/order.controller.ts#L22-L25)

Один декоратор покрывает оба маршрута контроллера
(`POST /order`, `PUT /order/:id/confirm`). Аналогично —
`ProductController` (только `GET /product/:id/stock`).

Admin-only endpoint (нужен только для E2E-теста role-guard'а
на 403):

```typescript
// apps/api-gateway/src/modules/auth/presentation/auth-admin.controller.ts
@ApiTags('Auth (admin)')
@Controller('auth/admin')
export class AuthAdminController {
  @Get('ping')
  @Roles(RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOkResponse({ schema: { example: { ok: true } } })
  @ApiForbiddenResponse({ description: 'Admin role required' })
  public ping(): { ok: true } {
    return { ok: true };
  }
}
```

> [GitHub: apps/api-gateway/src/modules/auth/presentation/auth-admin.controller.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/presentation/auth-admin.controller.ts#L9-L20)

ADR-010 §8 явно говорит: этот endpoint существует для одной
цели — иметь target, на котором customer-пользователь должен
получить 403. Когда появится настоящая admin-surface, этот
ping-stub заменят.

### Login: где живёт rotation

```typescript
// apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts
  public async execute(command: ILoginCommand): Promise<ILoginResult> {
    const email = command.email.trim().toLowerCase();
    const user = await this.users.findByEmail(email);

    if (!user?.isActive) {
      this.logger.warn({ email }, 'LoginFailed: user not found or inactive');
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await user.validatePassword(command.password, this.hasher);
    if (!passwordValid) {
      this.logger.warn({ userId: user.id, email }, 'LoginFailed: bad password');
      throw new UnauthorizedException('Invalid credentials');
    }
    // …
    const refreshToken = await this.tokens.issueRefreshToken({ sub: user.id, jti: refreshJti });

    user.rotateRefreshTokenHash(await this.hasher.hash(refreshToken));
    user.recordLoggedIn();
    await this.users.save(user);
    // …
  }
```

> [GitHub: apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts#L25-L69)

Две операции, на которых стоит залипнуть:

1. **И «нет такого user'а», и «неверный пароль» возвращают
   одну и ту же 401 + одинаковый текст.** Это анти-user-
   enumeration: атакующий не может через ответ отличить
   «логина не существует» от «пароль неверный». Pino-лог
   фиксирует разницу для observability — но он не уходит
   клиенту.
2. **Refresh-token-hash сохраняется до того, как мы вернём
   токены.** То есть: к моменту, когда клиент получит `200 OK`
   с парой токенов, в БД уже лежит хэш refresh'а. Если что-то
   упадёт между `users.save(user)` и `return` — клиент не
   получит ответ (и retry'нёт), а сохранённый хэш просто
   останется orphan-ом (refresh-токен у клиента не появится).

### Refresh: rotation reuse-detection в действии

```typescript
// apps/api-gateway/src/modules/auth/application/use-cases/refresh-token.use-case.ts
    const matches = await this.hasher.verify(user.refreshTokenHash, command.refreshToken);
    if (!matches) {
      // Rotation reuse: token was already exchanged. Conservative response is
      // to invalidate the live refresh hash so an attacker can't keep using
      // the most recent valid one.
      user.rotateRefreshTokenHash(null);
      await this.users.save(user);
      this.logger.warn({ userId: user.id }, 'RefreshFailed: rotation reuse detected');
      throw new UnauthorizedException('Invalid refresh token');
    }
```

> [GitHub: apps/api-gateway/src/modules/auth/application/use-cases/refresh-token.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/application/use-cases/refresh-token.use-case.ts#L37-L46)

Цепочка событий:

1. Атакующий украл refresh-токен (хэш-в-БД соответствует ему).
2. Атакующий делает `POST /auth/refresh` — получает **новую**
   пару и теперь legitimate refresh-токен в БД заменён на
   новый-атакующий.
3. Жертва возвращается, делает `POST /auth/refresh` со **своим
   (старым)** refresh'ем. Argon2-verify falsifies (хэш в БД
   — уже от атакующего). Use-case обнуляет `refreshTokenHash`
   и возвращает 401.
4. Теперь жертва **и** атакующий потеряли сессию. Жертва должна
   залогиниться заново.

Это не идеальная защита (она не отзывает уже выпущенные
access-токены — те живут до своих 15 минут), но она резко
сокращает окно эксплуатации refresh'а. ADR-010 §3 фиксирует
этот compromise.

### Joi-schema валидирует пароли-как-секреты на старте

```typescript
// libs/config/config-module.config.ts
    JWT_ACCESS_SECRET: Joi.string().min(32).required(),
    JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
    JWT_REFRESH_SECRET: Joi.string()
      .min(32)
      .required()
      .invalid(Joi.ref('JWT_ACCESS_SECRET'))
      .messages({
        'any.invalid': 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
      }),
    JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),
    AUTH_ARGON2_MEMORY_COST: Joi.number().integer().positive().default(19_456),
    AUTH_ARGON2_TIME_COST: Joi.number().integer().positive().default(2),
    AUTH_ARGON2_PARALLELISM: Joi.number().integer().positive().default(1),
```

> [GitHub: libs/config/config-module.config.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/config/config-module.config.ts#L25-L37)

Что закрывают эти строки:

- Минимум 32 символа на каждый секрет (≈256 бит энтропии для
  base64-секретов): меньше — HMAC-SHA-256 теряет защитный
  margin.
- Cross-field-проверка `invalid(Joi.ref('JWT_ACCESS_SECRET'))`:
  если кто-то скопировал `.env` и забыл сгенерировать второй
  секрет, stack не стартует. Joi даёт нам **fail-fast** на
  boot'е, что для безопасности всегда правильнее, чем silent
  degradation.
- Argon2-параметры — со значениями по OWASP 2024
  (`memoryCost: 19_456` KiB, `timeCost: 2`, `parallelism: 1`).
  Можно повысить (cost-параметры — это рычаг под нагрузку
  серверов), но не понизить ниже OWASP-минимума.

### Где `User` живёт как aggregate

`apps/api-gateway/src/modules/auth/domain/user.model.ts`
([GitHub](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/domain/user.model.ts#L23-L109))
— это **AggregateRoot<string>** с:

- инвариантами в private-конструкторе (email-regex, нет пустых
  ролей, нет пустого password-хэша);
- factory-методами `User.register()` (создаёт + добавляет
  `UserRegisteredEvent`) и `User.rehydrate()` (восстанавливает
  из БД без события);
- поведением: `assignRole`, `revokeRole` (защита от «нельзя
  отозвать последнюю роль»), `rotateRefreshTokenHash`,
  `validatePassword(candidate, hasher)`, `recordLoggedIn`.

`UserEntity` (TypeORM) и `User` (domain) — две разные вещи;
mapping живёт в `UserMapper`. Подробности — в
[[entity-vs-domain-model]] и [[mappers-and-repositories]];
здесь важно лишь, что domain-side имеет поведение, а
infrastructure-side — структуру.

## Связанные решения

- [[auth-stack-overview]] — полный request-flow с диаграммой
  и пер-слоевыми деталями. Эта статья — концепция; та —
  «как оно бежит на конкретном запросе».
- [[lib-nestjs-passport]], [[lib-passport]],
  [[lib-passport-jwt]], [[lib-nestjs-jwt]], [[lib-argon2]] —
  пять пакетов, образующих стек. Здесь рассматривается
  суммарная картина; за деталями — туда.
- [[hexagonal-architecture]] — `IAuthUserValidator` и
  `USER_REPOSITORY` — образцовые порты.
- [[api-gateway-pattern]] — почему именно gateway, а не
  отдельный user-микросервис, держит `User`.
- [[shared-libs-philosophy]] — почему `libs/auth` framework-
  glue, а `libs/contracts/auth` framework-free.
- [[entity-vs-domain-model]] — `User` vs `UserEntity`.
- ADR-010 — оригинальное решение.
- ADR-019 — TypeORM+MySQL стек, на который лёг `user`.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Identification | «Кто это утверждает, что он»; у нас — `sub` в JWT. |
| Authentication | Доказательство identification; у нас — подпись JWT. |
| Authorization | Право на конкретное действие; у нас — `roles[]` + `@Roles(...)`. |
| JWT (JSON Web Token) | Подписанный JSON-токен; access + refresh. |
| HS256 | HMAC-SHA-256: симметричная подпись JWT, один секрет. |
| RS256 | RSA-SHA-256: пара ключей, отвергнута для портфольного scope. |
| Access token | Короткоживущий (15m) JWT с `roles[]`. |
| Refresh token | Долгоживущий (7d) JWT, обменивается на новую пару. |
| Token rotation | На каждом refresh — **новый** refresh, старый недействителен. |
| Rotation reuse-detection | Попытка переиспользовать обменянный refresh → invalidate всех сессий. |
| `JwtAuthGuard` | Global `APP_GUARD`; уважает `@Public()`. |
| `RolesGuard` | Global `APP_GUARD`; сверяет `request.user.roles` со списком `@Roles(...)`. |
| `@Public()` | Декоратор-метаданные `auth:isPublic`. |
| `@Roles(...)` | Декоратор-метаданные `auth:roles`. |
| `@CurrentUser()` | Param-decorator, читает `request.user`. |
| `APP_GUARD` | Nest-токен: guard, применяемый глобально. |
| `RoleEnum` | `'admin' \| 'customer'`; источник правды — `libs/contracts/auth`. |
| `RoleVO` | Domain-side value object вокруг `RoleEnum`. |
| `AggregateRoot<TId>` | DDD-базовый класс из `libs/ddd`; `User` — первый строк-keyed. |
| argon2id | Hybrid memory-hard hash; OWASP-рекомендация по умолчанию. |
| OWASP A01:2021 | Broken Access Control — top-1 риск в web-приложениях. |
| Fail-closed | Дефолт «всё запрещено, открой явно»; противоположность fail-open. |
| User enumeration | Возможность отличить «нет логина» от «неверный пароль». У нас блокирована. |
| `AUTH_USER_VALIDATOR` | DI-port: app даёт способ резолва user'а по JWT-payload'у. |

> [!faq]- Проверь себя
> 1. Почему `JwtAuthGuard` и `RolesGuard` зарегистрированы в
>    `app.module.ts` через `APP_GUARD`, а не повешены на
>    каждый controller вручную? Что было бы, если бы они
>    регистрировались на уровне controller'а?
> 2. Что произойдёт, если в `.env.local` поставить
>    `JWT_ACCESS_SECRET === JWT_REFRESH_SECRET`?
> 3. Атакующий стащил refresh-токен. Опиши последовательность,
>    после которой и атакующий, и жертва теряют сессию.
> 4. Почему `validate-user.use-case.ts` загружает user'а по
>    `payload.sub` и проверяет `isActive`, а не просто
>    пробрасывает payload как есть в `req.user`?
> 5. Можно ли повесить `@Public()` на весь class
>    (controller) и убрать его с конкретных методов? Что
>    Reflector сделает в этом случае?

## Что почитать дальше

- [ADR-010 в репозитории](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/010-jwt-rbac-at-the-gateway.md)
  — исходное решение с rejected-альтернативами.
- [OWASP JWT Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
  — RS256/HS256 tradeoffs, экспирация, jti.
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
  — почему argon2id с конкретными cost-параметрами.
- [Auth0 Refresh Token Rotation explainer](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)
  — диаграмма rotation reuse-detection.
