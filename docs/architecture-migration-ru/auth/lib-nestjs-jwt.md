---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, auth, library, jwt, nest]
status: review
related:
  - "[[auth-stack-overview]]"
  - "[[jwt-and-rbac]]"
  - "[[lib-passport-jwt]]"
  - "[[lib-nestjs-passport]]"
  - "[[lib-passport]]"
  - "[[shared-libs-philosophy]]"
---

# Библиотека: `@nestjs/jwt`

> [!abstract] Кратко
> `@nestjs/jwt` — это **NestJS-обёртка над `jsonwebtoken`**,
> которая регистрирует `JwtService` (с методами `signAsync` и
> `verifyAsync`) под Nest-DI и принимает асинхронный конфиг
> через `JwtModule.registerAsync`. У нас он используется для
> **подписи** access и refresh-JWT в `/auth/login`, для
> **выпуска** новой пары в `/auth/refresh`, и для **проверки
> refresh-JWT** в `RefreshTokenUseCase`. Проверкой
> входящих access-JWT занимается **другой** пакет —
> `passport-jwt` ([[lib-passport-jwt]]).

## Зачем оно нам

Подписать JWT — это:

1. Сериализовать payload в JSON;
2. Base64URL-encode'нуть header и payload;
3. Посчитать HMAC-SHA-256 (для HS256) от
   `header.payload` с секретом;
4. Склеить три куска через `.`.

Можно сделать руками. Но в Nest проще:

- `JwtService` — `@Injectable()`, его можно инжектить туда,
  где он нужен;
- секреты и `expiresIn` берутся из `ConfigService` через
  `registerAsync` — без хардкода в коде;
- API типизирован (важно — `signAsync<TPayload>`).

И — что не менее важно — `@nestjs/jwt` использует
**`jsonwebtoken`** под капотом, та же библиотека, на которую
опирается `passport-jwt`. Один источник правды для
verify-сигнатуры между двумя половинами стека.

## Что этот пакет делает

### `JwtModule.registerAsync`

```typescript
// libs/auth/auth.module.ts
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
```

> [GitHub: libs/auth/auth.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/auth/auth.module.ts#L27-L38)

`registerAsync` — стандартная Nest-фабрика-конвенция (то же,
что `JwtModule.register`, но `useFactory` видит DI). Что
важно:

- `secret` — это **default** secret для всех `signAsync`-
  вызовов без `secret:`-overrid'а в опциях.
- `signOptions.expiresIn` — **default** lifetime; тоже
  переопределяется per-call.
- Конфиг применяется один раз на boot — `JwtService`-
  инстанс singleton.

### `JwtService.signAsync<TPayload>(payload, options?)`

`JwtService` — единственный класс, ради которого пакет и
существует. У нас в `JwtTokenAdapter`:

```typescript
// apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts
public issueAccessToken(payload: Omit<IJwtAccessPayload, 'iat' | 'exp'>): Promise<string> {
  return this.jwtService.signAsync(payload, {
    expiresIn: this.accessExpiresIn as JwtSignOptions['expiresIn'],
  });
}

public issueRefreshToken(payload: Omit<IJwtRefreshPayload, 'iat' | 'exp'>): Promise<string> {
  return this.jwtService.signAsync(payload, {
    secret: this.refreshSecret,
    expiresIn: this.refreshExpiresIn as JwtSignOptions['expiresIn'],
  });
}
```

> [GitHub: apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts#L43-L54)

Обратите внимание:

1. `issueAccessToken` **не передаёт** `secret:` в опциях —
   следовательно, используется default из `registerAsync`
   (т.е. `JWT_ACCESS_SECRET`).
2. `issueRefreshToken` **передаёт** `secret: this.refreshSecret` —
   override на `JWT_REFRESH_SECRET`.

Это и есть наш способ иметь **два разных секрета через
один `JwtService`-инстанс**: registerAsync даёт default,
а per-call override справляется со вторым. Альтернатива —
два `JwtService`-инстанса, по одному на каждый секрет — но
это тянет два registrar'а и дублирование конфигурации.

### `JwtService.verifyAsync<TPayload>(token, options?)`

```typescript
public verifyRefresh(token: string): Promise<IJwtRefreshPayload> {
  return this.jwtService.verifyAsync<IJwtRefreshPayload>(token, { secret: this.refreshSecret });
}
```

> [GitHub: apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts#L56-L58)

`verifyAsync`:

- проверяет подпись;
- проверяет `exp`;
- бросает на любую ошибку (поэтому use-case заворачивает в
  `try/catch`).

**Зачем нам verify через `@nestjs/jwt`, если для access-JWT
verify делает passport-jwt?** Потому что refresh-JWT идёт
**не в `Authorization: Bearer`**, а в POST-body на
`/auth/refresh`. Passport-стек его не видит. Нужен
программный verify — это `verifyAsync`.

### Параметры `JwtSignOptions`

- `secret` / `privateKey` — override на конкретный вызов.
- `expiresIn` — строка (`'15m'`, `'7d'`) или число секунд.
- `algorithm` — `'HS256'`, `'RS256'`, …. По умолчанию
  `HS256` (для `secret: string`).
- `notBefore` — `nbf`-claim.
- `issuer`, `audience`, `subject`, `jwtid` — стандартные
  claims; мы кладём `sub` и `jti` сами в payload, не через
  опции.

### Подробности парсинга `expiresIn`

`expiresIn: '15m'` — формат `jsonwebtoken`: число с
суффиксом (`s`, `m`, `h`, `d`). Если передать число — это
**секунды**. Чтобы знать, сколько ровно секунд возвращать в
`expiresIn`-поле response'а, наш `JwtTokenAdapter`
дублирует парсинг:

```typescript
const SECONDS_PER_UNIT: Record<string, number> = {
  s: 1, m: 60, h: 3600, d: 86400,
};

const parseDuration = (value: string): number => {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`Invalid JWT duration: ${value}`);
    }
    return seconds;
  }
  return Number(match[1]) * SECONDS_PER_UNIT[match[2]];
};
```

> [GitHub: apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts#L9-L26)

Это маленький компромисс: `@nestjs/jwt` (через
`jsonwebtoken`) принимает `'15m'`-строку и сам её парсит для
`exp`-claim'а, но **не предоставляет** «верни мне число секунд
из этой строки» API. Поэтому мы парсим один раз сами для
ответа клиенту.

## Что этот пакет НЕ делает

- **Не извлекает JWT из request-header'а.** Это работа
  `passport-jwt`-Strategy (`ExtractJwt.fromAuthHeaderAsBearerToken()`).
- **Не работает с request-pipeline'ом.** `JwtService` —
  стандартный provider, не middleware и не guard. Его надо
  явно вызывать.
- **Не делает RBAC.** Roles внутри payload — обычное поле,
  `JwtService` его не интерпретирует.
- **Не хэширует пароли.** `argon2`/`bcrypt` — независимо.
- **Не реализует JWT-spec.** Под капотом — `jsonwebtoken`-
  пакет. `@nestjs/jwt` лишь оборачивает его в Nest-DI-
  стиль.
- **Не управляет ротацией ключей.** Default secret один на
  boot; для динамической ротации придётся писать кастом.
- **Не работает с приватными ключами вне коробки.** Для
  RS256 надо явно передавать `privateKey: '…PEM…'` в
  `signOptions` и `publicKey:` в verify-options.
- **Не различает access vs refresh.** Это уже наша
  семантика: один `JwtService` подписывает оба, разница
  только в secret'е и payload-shape'е.

## Где используется в проекте

| Файл | Импорт | Что делает |
|------|--------|------------|
| `libs/auth/auth.module.ts` | `JwtModule`, `JwtSignOptions` | `registerAsync` + типизация. |
| `apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts` | `JwtService`, `JwtSignOptions` | Inject'ит `JwtService` в `JwtTokenAdapter`. |

Это все два места. Boundaries-правило ([[shared-libs-philosophy]],
ADR-017) не пускает `@nestjs/jwt` дальше: ни один use case,
ни один domain-model, ни один controller не импортирует его.

`JwtTokenAdapter` — это adapter паттерна port-and-adapter:
он **реализует** `ITokenPort`
([GitHub](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/application/ports/token.port.ts#L12-L18)),
и только он знает про `JwtService`. Use-case'ы
(`LoginUseCase`, `RefreshTokenUseCase`) инжектят
`TOKEN_SERVICE`-symbol, а не `JwtService`:

```typescript
constructor(
  // …
  @Inject(TOKEN_SERVICE) private readonly tokens: ITokenPort,
) {}
```

> [GitHub: apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts#L19-L23)

Это — образец того, как «framework-specific lib» (`@nestjs/jwt`)
изолируется одной adapter-точкой.

## Симметричная пара с `passport-jwt`

| Аспект | `@nestjs/jwt` | `passport-jwt` |
|--------|---------------|----------------|
| Sign | да (`signAsync`) | нет |
| Verify | да (`verifyAsync`) | да (через `passport.authenticate`) |
| Extract из request'а | нет | да (`ExtractJwt`) |
| Где запускается | `LoginUseCase`, `RefreshTokenUseCase` | На каждом authenticated-запросе через `JwtAuthGuard` |
| Возвращаемый result | `string` (signed) или `payload` (verified) | `req.user = result of validate()` |
| Что под капотом | `jsonwebtoken` | `jsonwebtoken` (тот же) |

Один и тот же `jsonwebtoken`-пакет — это и хорошо
(совместимость гарантирована), и важный момент для
аудита: если в `jsonwebtoken` находят уязвимость, оба
пакета затронуты.

## Тривия: `secretOrPublicKey` в `verifyAsync`

В `@nestjs/jwt` опция называется `secret` (для симметричных
алгоритмов) или `publicKey` (для асимметричных). У нас
HS256 → `secret`. Если когда-нибудь перейдём на RS256, надо
будет:

1. Сменить `secret: …` на `publicKey: …PEM…` в
   `verifyAsync`.
2. Передавать `algorithm: 'RS256'` в `signOptions`.
3. Передавать `algorithms: ['RS256']` в verify-options.

И — критично — переписать **passport-jwt**-strategy так же
(там тоже надо явно указать `algorithms: ['RS256']`, иначе
alg-confusion).

## Связанные решения

- [[auth-stack-overview]] — где `@nestjs/jwt` встаёт на
  диаграмме (на login-flow и в `verifyRefresh`).
- [[lib-passport-jwt]] — симметричная пара по
  `verify`-стороне.
- [[lib-nestjs-passport]] / [[lib-passport]] — связанная
  серия пакетов.
- [[jwt-and-rbac]] — про два секрета, rotation.
- [[shared-libs-philosophy]] — `@nestjs/jwt` живёт только
  в `libs/auth` и `JwtTokenAdapter`.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@nestjs/jwt` | NPM-пакет: NestJS-обёртка над `jsonwebtoken`. |
| `JwtModule.registerAsync` | Регистратор `JwtService` с DI-конфигом. |
| `JwtService` | Класс с `signAsync` / `verifyAsync`. |
| `JwtSignOptions` | Тип опций `signAsync` (secret, expiresIn, algorithm, …). |
| `signAsync<T>(payload, opts)` | Подписать → `Promise<string>`. |
| `verifyAsync<T>(token, opts)` | Проверить → `Promise<T>`. |
| `expiresIn` | Lifetime; `'15m'`, `'7d'`, … или число секунд. |
| `secretOrKey` (passport-jwt vs `secret` у @nestjs/jwt) | Один и тот же концепт, разный naming. |
| `jsonwebtoken` | NPM-пакет; реальный исполнитель sign/verify. Используется и `@nestjs/jwt`, и `passport-jwt`. |
| `algorithm` | Алгоритм подписи: `HS256` у нас. |

> [!faq]- Проверь себя
> 1. У нас один `JwtService`-инстанс. Как он подписывает
>    JWT двумя **разными** секретами?
> 2. Почему `RefreshTokenUseCase.verifyRefresh()` использует
>    `@nestjs/jwt`, а не `passport-jwt`?
> 3. В чём разница между `signAsync` и `verifyAsync`?
>    Когда мы пользуемся одним, а когда — другим?
> 4. Можно ли передать `secret` через `JwtModule.register`
>    без `Async`-варианта? Что мы потеряем?
> 5. Зачем `JwtTokenAdapter` парсит `'15m'` руками для
>    `accessTokenExpiresInSeconds()`?

## Что почитать дальше

- [`@nestjs/jwt` README](https://docs.nestjs.com/security/authentication#jwt-functionality)
  — registerAsync, signAsync, verifyAsync.
- [`jsonwebtoken` README](https://github.com/auth0/node-jsonwebtoken#readme)
  — реальный исполнитель.
- [[lib-passport-jwt]] — кто verify'ит access-JWT, и зачем
  нужны **оба** пакета.
