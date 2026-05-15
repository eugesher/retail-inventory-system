---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, auth, library]
status: review
related:
  - "[[auth-stack-overview]]"
  - "[[jwt-and-rbac]]"
  - "[[lib-nestjs-passport]]"
  - "[[lib-passport-jwt]]"
  - "[[shared-libs-philosophy]]"
---

# Библиотека: `passport`

> [!abstract] Кратко
> `passport` (NPM-пакет, v0.7.0 в проекте) — это **runner**
> для стратегий аутентификации в Express-/Connect-стиле.
> Сам по себе он ничего не знает ни про JWT, ни про OAuth,
> ни про login/password — он лишь оборачивает чужие
> стратегии (`passport-jwt`, `passport-local`,
> `passport-google-oauth20`, …), регистрирует их под
> именем и запускает на каждом request'е через
> `passport.authenticate(name)`. В проекте мы не вызываем
> `passport` напрямую — его API скрывает `@nestjs/passport`
> ([[lib-nestjs-passport]]).

## Зачем оно нам

Аутентификация в Node.js-приложении — это, по сути, паттерн
«middleware-цепочка»: HTTP-запрос приходит, какой-то
middleware решает, кто этот клиент, кладёт результат в
`req.user`, и пускает запрос дальше. Если правил много —
JWT, session cookie, Basic auth, OAuth-провайдеры, — каждое
правило стоило бы написать как отдельный middleware. И
тогда придётся, при добавлении любого нового провайдера,
переписывать boilerplate-обвязку.

`passport` решает это раз и навсегда: «middleware-машина»
универсальная, а «правило» — отдельная стратегия,
зарегистрированная под именем. Library-side остаётся
стабильной; стратегии добавляются как отдельные NPM-
пакеты.

## Что этот пакет делает

### Реестр стратегий

`passport` держит global registry (`{ [name]: strategy }`).
Когда новый Strategy-инстанс «инициализируется» (у нас —
через `PassportStrategy`-mixin из `@nestjs/passport`),
он регистрируется в реестре под своим именем:

```typescript
// концептуально, под капотом @nestjs/passport
passport.use('jwt', new JwtStrategyInstance({ /* options */ }));
```

После этого `passport.authenticate('jwt', options)(req, res, next)`
найдёт в реестре стратегию с этим именем и запустит её.

### Middleware-runner

На каждый запрос:

1. `passport.authenticate(name)(req, res, next)` — Express-
   middleware-функция.
2. Внутри:
   - находит стратегию `name`;
   - зовёт `strategy.authenticate(req, options)`;
   - стратегия делает что-то транспорт-специфическое
     (passport-jwt — извлекает Bearer-токен из header'а,
     verify'ит подпись), потом зовёт один из callback'ов
     `this.success(user)` / `this.fail()` / `this.error()`;
   - на `this.success(user)`: passport кладёт `user` в
     `req.user` и зовёт `next()` (запрос идёт дальше);
   - на `this.fail()`: 401 (или 403, если стратегия так
     решила);
   - на `this.error(err)`: 500.

Это — **всё**, что делает passport-runner. Сама логика «JWT
ли это, корректна ли подпись, что такое expired» — внутри
конкретной стратегии (`passport-jwt`).

### `req.user` — единая конвенция

`passport` устанавливает единое имя свойства — `request.user`
— куда любая стратегия кладёт результат. Это позволяет
нашему `@CurrentUser()` декоратору работать одинаково,
**неважно**, какая стратегия его наполнила: сейчас это
JWT, завтра может быть `passport-google-oauth20`.

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

Этот декоратор не упоминает `passport` — но без passport'а
`request.user` никто бы не выставил.

## Что этот пакет НЕ делает

Список — это самое полезное про runner'ы.

- **Не реализует ни одной стратегии.** Все 500+ стратегий —
  отдельные пакеты на NPM (`passport-jwt`, `passport-local`,
  `passport-oauth2`, …). Сам `passport` без стратегии
  бесполезен.
- **Не парсит JWT, не извлекает токены из header'а.** Это
  — `passport-jwt` ([[lib-passport-jwt]]).
- **Не выпускает JWT.** Этим занимается `@nestjs/jwt`
  ([[lib-nestjs-jwt]]) — совсем другой пакет, не входит в
  passport-экосистему вообще.
- **Не хэширует пароли.** `argon2`/`bcrypt` — независимо
  ([[lib-argon2]]).
- **Не управляет сессиями.** `passport.session()` —
  опциональный middleware, который **мы не используем**
  (ADR-010: stateless JWT, без cookies/session-store).
- **Не serialize'ит пользователя.** `passport.serializeUser` /
  `deserializeUser` — это session-API; мы его не вызываем.
- **Не знает про NestJS execution-context.** Passport — это
  Express/Connect-middleware. Связь с Nest даёт
  `@nestjs/passport` ([[lib-nestjs-passport]]).
- **Не делает RBAC.** Passport заканчивается на
  «`req.user` = что-то». Что дальше делать с `roles[]` — это
  уже наш `RolesGuard`.

## Где используется в проекте

Удивительно, но **нигде напрямую**. Поиск по проекту:

```bash
$ grep -r "from 'passport'" libs/ apps/
# (пусто)
```

Это и есть смысл `@nestjs/passport` ([[lib-nestjs-passport]])
— ни одной строчки `import 'passport'` в нашем коде нет.
Passport-runner живёт внутри `PassportModule` и
`AuthGuard()`-фабрики, никаких прямых вызовов API не
требуется.

В `package.json` он значится как **runtime-зависимость**
(`passport@^0.7.0`), потому что `@nestjs/passport`
объявляет его как `peerDependency`. Это типичный паттерн
для wrapper-пакетов: «я не хочу решать, какую версию
core'а вы используете — поставьте сами».

## Тривия: что значит major-номер `0.7`

`passport` живёт в 0.x.y-нумерации почти 15 лет — это
сознательно «pre-1.0» декларация: API не зафиксирован, но
на практике он стабилен с 2012 года. Major-апдейты
(`0.4 → 0.5 → 0.6 → 0.7`) обычно — security-патчи и
removed-deprecated-API. У нас `passport@0.7.0`, под него
рассчитан `@nestjs/passport@11.x`. Понижение на `0.6.x`
скорее всего проедет, повышение на гипотетический `0.8.x`
без апдейта `@nestjs/passport` — рискованно.

## Связанные решения

- [[auth-stack-overview]] — passport-runner сидит между
  `AuthGuard('jwt')` и `passport-jwt`-Strategy в
  диаграмме.
- [[lib-nestjs-passport]] — Nest-обёртка, скрывающая
  passport-API.
- [[lib-passport-jwt]] — конкретная стратегия, которую
  passport-runner запускает.
- [[jwt-and-rbac]] — про `req.user` и `@CurrentUser()`.
- [[shared-libs-philosophy]] — почему library-конкретику
  не утаскивают в app-side.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `passport` | NPM-пакет: middleware-runner для стратегий. |
| Strategy | Класс с `authenticate(req)` методом; реализует конкретный способ проверки. |
| Strategy registry | Глобальный map `{ name → instance }` внутри passport'а. |
| `passport.authenticate(name)` | Express-middleware-фабрика; запускает стратегию `name`. |
| `req.user` | Свойство, куда passport кладёт результат успешной стратегии. |
| `this.success / fail / error` | Callback'и стратегии для возврата результата passport-runner'у. |
| `peerDependency` | NPM-зависимость, версия которой согласуется wrapper'ом. |

> [!faq]- Проверь себя
> 1. Если в проекте удалить `passport` из `package.json`,
>    но оставить `@nestjs/passport`, `passport-jwt` и
>    наш `JwtStrategy`, — что сломается? На каком моменте?
> 2. Почему `@CurrentUser()` декоратор работает «одинаково»
>    независимо от того, какая стратегия выставила
>    `req.user`?
> 3. Чем passport-`session()` отличается от того, что
>    делает наш `JwtAuthGuard`? Почему мы её не
>    используем?

## Что почитать дальше

- [`passport` официальный сайт](https://www.passportjs.org/) — список
  стратегий, концепции.
- [[lib-nestjs-passport]] — наш wrapper.
- [[lib-passport-jwt]] — конкретная стратегия.
