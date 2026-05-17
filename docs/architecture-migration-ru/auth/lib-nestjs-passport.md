---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, auth, library, nest]
status: final
related:
  - "[[auth-stack-overview]]"
  - "[[jwt-and-rbac]]"
  - "[[lib-passport]]"
  - "[[lib-passport-jwt]]"
  - "[[shared-libs-philosophy]]"
---

# Библиотека: `@nestjs/passport`

> [!abstract] Кратко
> `@nestjs/passport` — это **тонкий NestJS-адаптер** над
> NPM-пакетом `passport`. Он делает ровно три вещи:
> `PassportModule.register({ defaultStrategy })`,
> `PassportStrategy(Strategy, name)`-mixin (превращает
> чужой Passport-Strategy-класс в Nest-`@Injectable()`) и
> `AuthGuard(name)`-фабрика guard'ов. Всё. Сама стратегия
> аутентификации — это `passport-jwt` ([[lib-passport-jwt]]),
> а middleware-машинерия — `passport` ([[lib-passport]]).

## Зачем оно нам

В сыром `passport` ([[lib-passport]]) интеграция в NestJS
требует двух неудобств:

1. `passport`-стратегии — обычные классы без декораторов,
   значит Nest-DI про них ничего не знает. Если в стратегии
   нужно дёрнуть `ConfigService` или какой-нибудь port
   (например, `AUTH_USER_VALIDATOR`), это решается через
   ручное «передай в конструктор» — но Nest DI-контейнер
   на это не подписан.
2. `passport`-API работает через `app.use(passport.authenticate(...))`
   — Express-middleware-стиль, который чужд Nest-guard-pipeline'у.

`@nestjs/passport` решает обе проблемы: стратегии становятся
обычными `@Injectable()` (через `PassportStrategy`-mixin), а
guards — обычными Nest-`CanActivate` (через `AuthGuard()`-
фабрику).

## Что этот пакет делает

### `PassportModule.register({ defaultStrategy })`

```typescript
// libs/auth/auth.module.ts
PassportModule.register({ defaultStrategy: 'jwt' }),
```

> [GitHub: libs/auth/auth.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/auth.module.ts#L26)

Регистрирует Passport-инстанс в Nest-DI и проставляет
дефолт-стратегию (имя, под которым она зарегистрирована в
passport-registry'е). Дефолт нужен, чтобы можно было
вызвать `AuthGuard()` **без** аргумента и он бы знал, какую
стратегию запустить. У нас одна стратегия — `'jwt'` — и
дефолт совпадает с ней.

### `PassportStrategy(Strategy, name)`-mixin

Самая «магическая» часть пакета. Mixin принимает:

- `Strategy` — класс-стратегию из любого `passport-*`-
  пакета (у нас — `passport-jwt.Strategy`);
- `name` — имя, под которым её зарегистрировать в Passport-
  registry'е.

Возвращает **базовый класс**, от которого должен
наследоваться наш `JwtStrategy`:

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

  public async validate(payload: IJwtAccessPayload): Promise<ICurrentUser> {
    return this.userValidator.validate(payload);
  }
}
```

> [GitHub: libs/auth/jwt.strategy.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/jwt.strategy.ts#L10-L29)

Что mixin делает «под капотом»:

1. **Регистрирует** инстанс класса в passport-registry'е
   под именем `'jwt'`. Это значит, что когда где-то будет
   вызвано `AuthGuard('jwt')`, passport-middleware дёрнет
   именно этого инстанса.
2. **Перехватывает** наш метод `validate(payload)` и делает
   его passport-callback'ом. В сыром passport-jwt callback
   передаётся через нелобовой
   `done(err, user)`-API; `PassportStrategy` оборачивает
   это в Promise-friendly форму («верни значение — будет
   `user`; брось — будет 401»).
3. **Сохраняет** `@Injectable()`-семантику: мы можем
   дёргать через DI `ConfigService`, `AUTH_USER_VALIDATOR`
   и т.д. в конструкторе.

Технически `PassportStrategy(...)` возвращает класс, в
конструкторе которого вызывается `Reflect.construct` над
вашим `Strategy` с теми опциями, которые вы передали в
`super(...)`. Дальше mixin прячет всё, что про
passport-internals.

### `AuthGuard(name)`-фабрика guard'ов

```typescript
// libs/auth/jwt-auth.guard.ts
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  // …
}
```

> [GitHub: libs/auth/jwt-auth.guard.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/jwt-auth.guard.ts#L12)

`AuthGuard('jwt')` — это **фабрика классов**, не один
конкретный класс. Каждый вызов с другим аргументом возвращает
новый класс. У нас вызов один (`'jwt'`), и мы расширяем
полученный класс, чтобы добавить `@Public()`-short-circuit.

`AuthGuard(name)` под капотом — обычный `CanActivate`,
который:

1. Достаёт ExecutionContext'а из Nest.
2. Преобразует его в Express-`req`/`res`-пару.
3. Зовёт `passport.authenticate(name, options)(req, res, …)`.
4. Ждёт результата: либо `req.user` выставлен → `return true`;
   либо `UnauthorizedException` → 401.

Это **единственный** мост между Nest-guard'ом и
passport-middleware'ом.

## Что этот пакет НЕ делает

Полный список того, чего ожидать от `@nestjs/passport` **не
стоит**:

- **Не реализует ни одной стратегии аутентификации.**
  «JWT-стратегия» — это `passport-jwt` ([[lib-passport-jwt]]);
  `local`-стратегия (login/password) — `passport-local`;
  Google-OAuth — `passport-google-oauth20`. Сам `@nestjs/passport`
  — это **обёртка** над любой из них.
- **Не извлекает JWT из request'а.** Это делает
  `passport-jwt`-Strategy с `ExtractJwt.fromAuthHeaderAsBearerToken()`.
- **Не верифицирует подпись JWT.** Это делает `passport-jwt`
  (через `jsonwebtoken` под капотом).
- **Не выпускает JWT.** Для выпуска у нас `@nestjs/jwt`
  ([[lib-nestjs-jwt]]) — другой пакет.
- **Не хэширует пароли.** `argon2` ([[lib-argon2]]).
- **Не знает про `@Public()`/`@Roles()`.** Эти декораторы и
  guard'ы (`JwtAuthGuard.canActivate` с `IS_PUBLIC_KEY`-
  reflector'ом, `RolesGuard`) — наш кастомный код в
  `libs/auth`.
- **Не выставляет `request.user`.** Это делает
  passport-middleware ([[lib-passport]]) после успешного
  `validate()`-callback'а.
- **Не имеет понятия об execution-context'е.** Только сам
  по себе — он ничего не знает про Nest, кроме того, что
  `getRequest()` возвращает Express-`req`. (В fastify-
  варианте есть отдельный путь.)

### Хвост: лимит совместимости с не-HTTP-транспортом

`@nestjs/passport` `AuthGuard('jwt')` работает только для
HTTP-context'а (`context.switchToHttp().getRequest()`). На
RabbitMQ-handler'ах (`@MessagePattern`) этот guard не
запустится без отдельной адаптации (RPC-context имеет
другой shape). Сегодня это нас не блокирует — авторизация
живёт **только на gateway'е**, ниже идёт trust (см.
ADR-010 §6 «Token verification by downstream microservices is
deferred»).

## Где используется в проекте

Импорт `@nestjs/passport` встречается в проекте **только
дважды**, обе раза — в `libs/auth/`:

| Файл | Импорт | Зачем |
|------|--------|-------|
| `libs/auth/auth.module.ts` | `PassportModule` | `register({ defaultStrategy: 'jwt' })` в `forRootAsync`. |
| `libs/auth/jwt.strategy.ts` | `PassportStrategy` | Mixin-наследование для `JwtStrategy`. |
| `libs/auth/jwt-auth.guard.ts` | `AuthGuard` | Базовый класс для `JwtAuthGuard`. |

Ни одна gateway-app-side директория (`apps/api-gateway/src/modules/auth/`),
ни один микросервис `@nestjs/passport` не импортирует.
Boundaries-правило (см. [[shared-libs-philosophy]]) держит
этот импорт closed в `libs/auth`.

## Тривия: семантическая пара с passport

`@nestjs/passport@11.x` в проекте — он совместим с
`passport@0.7.x` (см. [[lib-passport]]). Совместимость
важна, потому что `PassportStrategy`-mixin лезет в
passport-registry-API; если major'ы расходятся (passport@0.8?),
обёртка может не работать без апдейта `@nestjs/passport`.

## Связанные решения

- [[auth-stack-overview]] — куда `@nestjs/passport` встаёт на
  диаграмме (между `JwtAuthGuard` и `passport-jwt`).
- [[lib-passport]] — слой ниже: middleware-runner.
- [[lib-passport-jwt]] — JWT-стратегия, которую mixin
  «перенесёт» в Nest-DI.
- [[lib-nestjs-jwt]] — про **выпуск** JWT, не входит в
  `@nestjs/passport`-mixin-flow.
- [[shared-libs-philosophy]] — почему импорт
  `@nestjs/passport` живёт **только** в `libs/auth`.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@nestjs/passport` | NPM-пакет: NestJS-обёртка над `passport`. |
| `PassportModule` | Nest-модуль; `register({ defaultStrategy })`. |
| `PassportStrategy(Strategy, name)` | Mixin-функция; превращает чужой Strategy-класс в Nest-DI-friendly базовый класс. |
| `AuthGuard(name)` | Фабрика guard'ов; принимает имя стратегии. |
| `defaultStrategy` | Имя стратегии, которое `AuthGuard()` использует, если вызвать без аргумента. |
| Mixin | Функция, возвращающая класс; используется для inheritance с runtime-композицией. |
| `Reflect.construct` | Низкоуровневый JS-механизм создания инстанса; mixin им пользуется. |

> [!faq]- Проверь себя
> 1. Что произойдёт, если в `libs/auth/auth.module.ts`
>    оставить `PassportModule.register({})` без
>    `defaultStrategy`? Где это сломается?
> 2. Можно ли `AuthGuard('jwt')` использовать на
>    `@MessagePattern`-handler'е RabbitMQ-микросервиса?
>    Почему да или нет?
> 3. В чём принципиальная разница между `PassportStrategy`
>    и `AuthGuard`? Какой используется для написания
>    стратегии, а какой — для применения?

## Что почитать дальше

- [`@nestjs/passport` README](https://docs.nestjs.com/recipes/passport)
  — официальный гид Nest, основные сценарии.
- [[lib-passport]] — слой ниже стека.
- [[lib-passport-jwt]] — конкретно JWT-стратегия,
  «оборачиваемая» через `PassportStrategy`.
