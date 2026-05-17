---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, auth, library, security, hashing]
status: final
related:
  - "[[auth-stack-overview]]"
  - "[[jwt-and-rbac]]"
  - "[[lib-nestjs-jwt]]"
  - "[[lib-passport-jwt]]"
  - "[[shared-libs-philosophy]]"
---

# Библиотека: `argon2`

> [!abstract] Кратко
> `argon2` (NPM-пакет, v0.44.0 в проекте) — это
> Node.js-обёртка над оригинальной C-реализацией
> argon2-алгоритма, победителя Password Hashing Competition.
> Мы используем **argon2id**-вариант для двух задач:
> хэширования пароля при регистрации и для хэширования
> refresh-токена в `user.refresh_token_hash`-колонке.
> Cost-параметры — OWASP-2024 минимум (`memoryCost: 19_456`
> KiB, `timeCost: 2`, `parallelism: 1`), настраиваются через
> `AUTH_ARGON2_*` env-vars. ADR-010 §2 объясняет, почему
> argon2id, а не bcrypt.

## Зачем оно нам

Пароли (и долгоживущие секреты, такие как refresh-токены)
**нельзя** хранить в БД в plain-виде или даже под обычным
crypto-hash'ем (SHA-256, MD5, …):

- быстрые hash'и (миллиарды/сек на GPU) делают rainbow-
  table-атаку и брутфорс тривиальными;
- даже salted-SHA не защищает — атака всё ещё параллелится
  на GPU/ASIC.

Password-hashing-algorithm должен быть **медленным
намеренно** — настолько, чтобы атакующий не мог пере
брать миллион паролей в секунду. И — что важнее
последнего десятилетия — **memory-hard**: использовать
много памяти, чтобы у GPU/ASIC терялось преимущество
(память — это дорогой ресурс).

`argon2id` — это OWASP-рекомендация по умолчанию для всех
новых приложений (2024 edition Cheat Sheet). Гибридная
форма `argon2id` сочетает:

- **argon2i** — устойчивость к side-channel-атакам;
- **argon2d** — устойчивость к time-memory tradeoff
  (брутфорсу).

`bcrypt` (предыдущий де-факто-стандарт) **не
memory-hard** и капается 72-байтным password input'ом — это
не «опасно», но «не оптимально для нового проекта». Поскольку
наш auth — greenfield, у нас нет legacy-bcrypt-хэшей, которые
надо мигрировать. Выбираем сразу argon2id.

## Что этот пакет делает

### `argon2.hash(plain, options)`

Принимает строку (или Buffer) и возвращает Promise со
**self-contained** строкой формата
`$argon2id$v=19$m=19456,t=2,p=1$<salt-base64>$<hash-base64>`.

В этой строке закодировано **всё**:

- alg (`argon2id`);
- версия (`v=19`);
- cost-параметры (`m=…,t=…,p=…`);
- случайно сгенерированный salt;
- сам hash.

Это значит:

1. Не надо отдельно хранить salt — он внутри строки.
2. Не надо хранить cost-параметры в БД — verify
   достанет их из строки и применит те же.
3. Каждый hash — уникален (даже для одного пароля), потому
   что salt каждый раз новый.

В нашем `Argon2PasswordAdapter`:

```typescript
// apps/api-gateway/src/modules/auth/infrastructure/argon2/argon2-password.adapter.ts
@Injectable()
export class Argon2PasswordAdapter implements IPasswordPort {
  private readonly options: argon2.Options;

  constructor(configService: ConfigService) {
    this.options = {
      type: argon2.argon2id,
      memoryCost: configService.get<number>('AUTH_ARGON2_MEMORY_COST'),
      timeCost: configService.get<number>('AUTH_ARGON2_TIME_COST'),
      parallelism: configService.get<number>('AUTH_ARGON2_PARALLELISM'),
    };
  }

  public hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  public async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
```

> [GitHub: apps/api-gateway/src/modules/auth/infrastructure/argon2/argon2-password.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/infrastructure/argon2/argon2-password.adapter.ts#L1-L31)

Тонкая деталь: `verify` **глотает** исключения и возвращает
`false`. Это сознательно — если в БД попадает «битый»
hash (например, после ручной миграции или баги-семечка),
мы не хотим 500, мы хотим «invalid credentials» как и
для wrong-password. Это часть defence in depth: атакующий
не отличит «пароль неверный» от «hash в БД покорёжен».

### `argon2.verify(hash, plain)`

Достаёт из hash-строки cost-параметры и salt, считает
заново hash для `plain` с теми же параметрами, сравнивает в
**constant-time** — что защищает от timing-атак.

Verify-операция занимает ~5–10 мс при наших cost-параметрах.
Это намеренно — атакующий с brute-force-словарём не сможет
проверять больше ~100 паролей/сек/CPU-core, что при разумной
энтропии пароля делает атаку нецелесообразной.

### Cost-параметры (наши значения)

Joi-schema (`libs/config/config-module.config.ts`):

```typescript
AUTH_ARGON2_MEMORY_COST: Joi.number().integer().positive().default(19_456),
AUTH_ARGON2_TIME_COST: Joi.number().integer().positive().default(2),
AUTH_ARGON2_PARALLELISM: Joi.number().integer().positive().default(1),
```

> [GitHub: libs/config/config-module.config.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/config/config-module.config.ts#L35-L37)

| Параметр | Default | Что означает |
|----------|---------|--------------|
| `memoryCost` (m) | `19_456` KiB ≈ 19 MiB | Сколько RAM используется per hash. Это и есть **memory-hard**. |
| `timeCost` (t) | `2` | Количество итераций; линейно влияет на CPU-время. |
| `parallelism` (p) | `1` | Сколько потоков использует hash. Для server-side обычно 1. |

19 MiB на один hash звучит много, но это и есть смысл
argon2id: при попытке параллельно посчитать 1000 hash'ей
GPU нужно 19 GB памяти, что не помещается на одну карту.
Это и есть смысл «memory-hard».

`timeCost: 2` плюс `memoryCost: 19_456` дают ~5–10 мс на
verify на typical server CPU. Если в будущем железо станет
быстрее (или нагрузка позволит больше), параметры можно
повысить через env-vars без code-change.

OWASP 2024 минимумы для argon2id:
- `memoryCost: 19_456` KiB (минимум);
- `timeCost: 2` (минимум);
- `parallelism: 1`.

Можно поднимать, понижать **нельзя** — это компромисс
безопасность-vs-latency.

### Hashing refresh-токена

Argon2-hash используется **дважды** на login-flow:

```typescript
// apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts
const passwordValid = await user.validatePassword(command.password, this.hasher);
// …
const refreshToken = await this.tokens.issueRefreshToken({ sub: user.id, jti: refreshJti });

user.rotateRefreshTokenHash(await this.hasher.hash(refreshToken));
```

> [GitHub: apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts#L34-L55)

1. **Verify** пароля при login (одно verify-call'е).
2. **Hash** свежевыпущенного refresh-токена, чтобы положить
   в `user.refresh_token_hash`.

Зачем хэшировать refresh-token, если он сам по себе
криптографически случаен (UUID + JWT-подпись)? Так же, как
с паролями — **defense in depth**. Если БД утечёт:

- Без хэша: атакующий получает живые refresh-токены и может
  выпускать access-токены до конца их 7-дневного срока.
- С хэшем: атакующий получает только argon2-хэши, которые
  даже при наличии оригинала verify'ят в 5–10 мс — и которые
  он не может реигрывать как сами токены.

Это удваивает workload на каждом refresh (~10–20 мс +
JWT-verify), но операция-то редкая (раз в 15 мин).

## Что этот пакет НЕ делает

- **Не подписывает JWT.** Это `@nestjs/jwt` ([[lib-nestjs-jwt]]).
- **Не проверяет JWT.** `@nestjs/jwt` (refresh) или
  `passport-jwt` (access) ([[lib-passport-jwt]]).
- **Не управляет user-state'ом.** `User`-aggregate и
  репозиторий — отдельно.
- **Не имеет отношения к session cookie / RBAC.**
- **Не делает constant-time-string-compare для произвольных
  строк.** `verify` — да, internal-сравнение constant-time,
  но `argon2.verify(hash, plain)`-API специфично для hash-
  string'ов.
- **Не работает синхронно.** `argon2.hash` и
  `argon2.verify` — оба async (CPU-bound операция уходит
  в worker pool через native-binding).
- **Не предоставляет MAC.** Если нужен HMAC — другой пакет
  (`crypto.createHmac` из стандартной библиотеки или
  `jsonwebtoken` для JWT).
- **Не валидирует пароль на сложность.** Это работа DTO-
  validator'а (`@MinLength(8)` в
  `LoginRequestDto`, см.
  [GitHub](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/presentation/dto/login.request.dto.ts#L11-L13)).

## Where it lives: `IPasswordPort` port-and-adapter

`Argon2PasswordAdapter` имплементирует `IPasswordPort`:

```typescript
// apps/api-gateway/src/modules/auth/application/ports/password.port.ts
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface IPasswordPort {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
}
```

> [GitHub: apps/api-gateway/src/modules/auth/application/ports/password.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/api-gateway/src/modules/auth/application/ports/password.port.ts#L1-L6)

Use case'ы инжектят `PASSWORD_HASHER`-symbol; домен-model
`User` зависит от **ещё более узкого** интерфейса
`IPasswordHasher` (только `verify`), что прописано прямо в
`user.model.ts`. См. [[hexagonal-architecture]]: модель
домена зависит от интерфейса, а реализация (`argon2`) —
infrastructure-detail, который можно заменить без
переписывания домена.

### `package.json`

`argon2@^0.44.0` — runtime-dep. Без dev-dep `@types/argon2` —
пакет сам приходит с типами. Под капотом — native module
(`node-gyp`-сборка); это значит, в Docker-image должны быть
`build-essential`, или нужен prebuilt binary, который
`argon2`-пакет умеет качать.

## Тривия: почему 19_456 KiB

`19_456` — это не число с потолка. Расчёт:

- 1 MiB = `1024 KiB`.
- 19 MiB = `19 × 1024 = 19_456 KiB`.

OWASP в 2024 году поднял рекомендацию с 12 MiB (старый
порог) до 19 MiB. Причина — постоянный рост дешёвой RAM
(на момент 2024 — 32 GB DDR5-планки доступны за $80, что
делает 12 MiB подъёмным для attacker-фермы).

## Связанные решения

- [[auth-stack-overview]] — где `argon2` встаёт на flow
  login'а.
- [[jwt-and-rbac]] — почему argon2id, не bcrypt;
  refresh-token-rotation; защита БД от утечки.
- [[lib-nestjs-jwt]] — пара по «выпуск/подпись токенов».
- [[lib-passport-jwt]] — пара по «проверка access-токенов».
- [[hexagonal-architecture]] — `IPasswordPort` и
  `IPasswordHasher` — два уровня абстракции вокруг
  `argon2`.
- [[shared-libs-philosophy]] — `argon2` живёт только в
  `Argon2PasswordAdapter`; ни одна другая директория его не
  импортирует.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Argon2 | Победитель Password Hashing Competition (2015). |
| Argon2id | Hybrid-вариант: устойчив к side-channel + к timing-атакам. |
| Memory-hard | Нужно много памяти на один hash → GPU-преимущество сходит на нет. |
| `memoryCost` (m) | Сколько KiB памяти используется per hash. |
| `timeCost` (t) | Количество итераций; влияет на CPU-время. |
| `parallelism` (p) | Сколько потоков использует один hash. |
| Salt | Случайные байты, добавляемые к паролю; защита от rainbow-table. |
| Rainbow-table | Pre-computed reverse-lookup hash → plaintext. |
| Constant-time compare | Сравнение строк без раннего exit'а; защита от timing-атак. |
| Bcrypt | Старый де-факто-стандарт; не memory-hard. |
| Defence in depth | Многоуровневая защита: хэш + cost-params + salt + constant-time. |
| `IPasswordPort` | DI-port: интерфейс hash/verify для use-cases. |
| `IPasswordHasher` | Узкий интерфейс (только verify) для domain-model. |
| OWASP A02:2021 | Cryptographic Failures — место, где «храним пароли в plain» проявляется. |

> [!faq]- Проверь себя
> 1. Что хранится в колонке `user.passwordHash`? Какие части
>    self-contained-строки можно достать оттуда без verify-
>    операции?
> 2. Почему мы хэшируем **сам refresh-токен** через
>    argon2, хотя он сам по себе уже криптографически
>    случаен?
> 3. `verify(hash, plain)` бросает исключение — наш адаптер
>    его глотает и возвращает `false`. Почему это безопасно
>    и зачем нужно?
> 4. Если в `.env.local` поставить
>    `AUTH_ARGON2_MEMORY_COST=512`, что произойдёт? И что
>    защищает от такого «оптимизации»?
> 5. Почему в `argon2`-hash-строке нет отдельной колонки
>    salt в БД? Где он хранится?

## Что почитать дальше

- [OWASP Password Storage Cheat Sheet (2024)](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
  — рекомендации параметров argon2id, bcrypt-fallback'и.
- [`argon2` NPM README](https://github.com/ranisalt/node-argon2#readme)
  — opt'ы, encoding, node-gyp-сборка.
- [Argon2 RFC 9106](https://datatracker.ietf.org/doc/html/rfc9106)
  — формальная спецификация алгоритма.
- [[jwt-and-rbac]] §«argon2id, а не bcrypt» — компактное
  объяснение.
