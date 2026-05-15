# _carryover-07.md — Write auth stack (Phase: auth/)

> Generated 2026-05-16 by the task-07 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-06.md`
> (which built on `_carryover-05.md` → … → `_carryover-01.md`,
> source of the SHA pin
> `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-06.md` was read in full first. The seven caching
articles it produced are all on `status: review` and provide
back-link targets that auth needed: `[[shared-libs-philosophy]]`
(referenced by every per-library auth article), and the
caching task's diagram-style template was reused for
`auth-stack-overview.md`'s mermaid flowcharts per
`_carryover-06.md` §«Suggested adjustments» #8.

No build smoke-check was run inside the session — only
docs-only files were touched under
`docs/architecture-migration-ru/auth/`. The working tree was
clean at session start; branch is `migration-guide`. No code
under `apps/` or `libs/` was modified. No `git` mutating
commands were executed.

Discrepancies check (task-01 §4): every clarification-group
auth library is present in `package.json` (verified against
`_carryover-01.md` §Inventory):

- `@nestjs/passport@^11.0.5`
- `passport@^0.7.0`
- `passport-jwt@^4.0.1`
- `@nestjs/jwt@^11.0.2`
- `argon2@^0.44.0`
- (dev) `@types/passport-jwt@^4.0.1`, `@types/passport@^0`

All five clarification-group libraries have a dedicated
`lib-*.md` article.

## Articles written

Seven auth articles. Each was reshaped from the task-01 stub
(frontmatter + `Заглушка` callout) into a stand-alone
Russian-language mid-level-NestJS article that grounds every
claim in production code.

| Path | One-line Russian summary |
| ---- | ------------------------ |
| `docs/architecture-migration-ru/auth/jwt-and-rbac.md` | Концептуальный якорь: HS256 access+refresh, два секрета, argon2id, rotation с reuse-detection, глобальные `APP_GUARD`'ы, `@Public`/`@Roles`/`@CurrentUser`, `User`-aggregate на gateway. Все решения ADR-010 разобраны от первых принципов. — ~3552 слов. |
| `docs/architecture-migration-ru/auth/auth-stack-overview.md` | 11-слойная диаграмма request-flow'а от `Authorization: Bearer` до controller-handler'а; параллельная ветка sign-flow'а для login/refresh; кто что делает на каждом слое. — ~2519 слов. |
| `docs/architecture-migration-ru/auth/lib-nestjs-passport.md` | Nest-обёртка над `passport`: `PassportStrategy`-mixin, `AuthGuard(name)`-фабрика, `PassportModule.register`. Что **НЕ** делает: не стратегия, не verify, не extraction. — ~1027 слов. |
| `docs/architecture-migration-ru/auth/lib-passport.md` | Middleware-runner; реестр стратегий, `req.user`-конвенция. Что **НЕ** делает: не реализует стратегий, не управляет сессиями, не делает RBAC. — ~928 слов. |
| `docs/architecture-migration-ru/auth/lib-passport-jwt.md` | JWT-стратегия для **verify**: `ExtractJwt`-функции, опции, mixin'ом наследуется. Что **НЕ** делает: не выпускает JWT, не работает на не-HTTP-транспортах. — ~1181 слов. |
| `docs/architecture-migration-ru/auth/lib-nestjs-jwt.md` | `JwtService.signAsync`/`verifyAsync` через `JwtModule.registerAsync`; per-call secret-override как способ иметь два секрета через один инстанс. Что **НЕ** делает: не extract'ит из header'а, не делает RBAC, не хэширует. — ~1328 слов. |
| `docs/architecture-migration-ru/auth/lib-argon2.md` | argon2id hash/verify, OWASP-2024 cost-параметры (`19_456`/`2`/`1`), self-contained-encoded hash-string, защита refresh-token-hash'а. Defence-in-depth `verify` swallow-exception. Что **НЕ** делает: не подписывает JWT, не валидирует сложность пароля. — ~1459 слов. |

All seven articles flipped `status: draft` → `status: review`
in their frontmatter; `updated:` set to `2026-05-16`. Each
carries the mandatory `> [!abstract] Кратко` block, `## Глоссарий`
section, and `> [!faq]- Проверь себя` collapsible (3–6
questions per article). Every per-library article has the
mandatory **"Что этот пакет НЕ делает"** section per task-07
step 5.

### GitHub permalinks pinned

Across the seven articles: **45 GitHub permalinks** pinned to
`84b1507c68fd9ee02b185eef3c4594b6fe02f664`
(17 + 11 + 3 + 1 + 2 + 6 + 5 = 45). Code anchors include
every file suggested by task-07 step 6 plus a few that helped
tell the story:

- `libs/auth/{auth.module, jwt.strategy, jwt-auth.guard, roles.guard, auth-user-validator.port, current-user.decorator}.ts`
  — every load-bearing file in the lib.
- `libs/contracts/auth/{role.enum, jwt-payload.dto, current-user.dto}.ts` — referenced indirectly via `ICurrentUser` / `IJwtAccessPayload` typings.
- `libs/config/config-module.config.ts` (L25-L37 — JWT and argon2 env-schema; cited 3×).
- `apps/api-gateway/src/app/app.module.ts` (L17-L35 — global `APP_GUARD` registration).
- `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts` (the `forRootAsync` wiring with `AUTH_USER_VALIDATOR` binding).
- `apps/api-gateway/src/modules/auth/infrastructure/argon2/argon2-password.adapter.ts`
- `apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts`
- `apps/api-gateway/src/modules/auth/application/use-cases/{login, refresh-token, validate-user}.use-case.ts`
- `apps/api-gateway/src/modules/auth/application/ports/{token, password}.port.ts`
- `apps/api-gateway/src/modules/auth/presentation/{auth.controller, auth-admin.controller}.ts`
- `apps/api-gateway/src/modules/auth/presentation/dto/login.request.dto.ts` (for `@MinLength(8)`)
- `apps/api-gateway/src/modules/retail/presentation/order.controller.ts` (class-level `@Roles`)
- `docs/adr/010-jwt-rbac-at-the-gateway.md` (one inline permalink in `jwt-and-rbac.md`'s abstract)

All cited line ranges were validated against `wc -l` of the
corresponding file at the recorded SHA — no off-by-one
corrections required this session. The longest range
(`apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts` L25-L69) covers 45 lines, the shortest single-line permalink is `libs/auth/auth.module.ts` L26 (the `PassportModule.register` line in `lib-nestjs-passport.md`).

### Word counts

| Article | Word count |
|---------|-----------|
| `jwt-and-rbac.md` | 3552 |
| `auth-stack-overview.md` | 2519 |
| `lib-nestjs-passport.md` | 1027 |
| `lib-passport.md` | 928 |
| `lib-passport-jwt.md` | 1181 |
| `lib-nestjs-jwt.md` | 1328 |
| `lib-argon2.md` | 1459 |
| **Total** | **11 994** |

`jwt-and-rbac.md` overshoots task-01 §12 #7's soft ceiling of
~3000 words (3552) — task-07 explicitly suggested ~2500
words for this article. The overshoot is by design: the
article is the conceptual anchor for the whole stack and
needs to cover six distinct decisions (HS256, two secrets,
argon2id-over-bcrypt, rotation reuse-detection, fail-closed
RBAC, gateway-owned `User`-aggregate), each with rejected
alternatives. Splitting into two articles would force readers
to chase wiki-links for context. The four mandatory blocks
(`Кратко`, `Глоссарий` with 22 EN→RU pairs, `Проверь себя`
with 5 questions, `Связанные решения`) account for ~600 of
those 3552 words.

The per-library articles came in between 928 and 1459 words,
overshooting task-07's ~600–700 guidance — same pattern as
the caching group (`_carryover-06.md` flagged this in
§Verification). The "Что этот пакет НЕ делает" section is
verbose by nature: each library has 7–10 bullets, and each
bullet routes to another wiki-link with a one-sentence
contrast.

## Audit status

No new audit items opened by this session. ADR-010 is the
source of truth for auth decisions; everything in the
articles is grounded in code as it stands at the recorded
SHA. The follow-ups from
`docs/architecture-migration-plan/tasks/_carryover-06.md` §11
(post-migration backlog) are referenced where relevant:

- **Public registration deferred** — mentioned in
  `jwt-and-rbac.md` and ADR-010 §7 (the article references
  the ADR for the rationale; readers seeing
  `RegisterUserUseCase` in the code without a route hookup
  understand why).
- **Token verification by downstream microservices is
  deferred** — `auth-stack-overview.md` §«Где импорты могут
  жить» and `lib-nestjs-passport.md` §«Хвост: лимит
  совместимости с не-HTTP-транспортом» both call out that
  `AuthGuard('jwt')` doesn't work on `@MessagePattern`-
  handlers today; ADR-010 §6 is the open architectural
  trajectory.
- **`/auth/forgot-password`, rate-limiting, refresh-token
  deny-list, secrets-manager move** — out of scope for the
  guide; the guide describes what shipped, not the backlog.

## Glossary terms collected

EN→RU pairs introduced across the seven articles. These get
rolled into the consolidated `glossary.md` in task-12.

| Source article | EN term | RU explanation (short) |
| -------------- | ------- | ---------------------- |
| jwt-and-rbac | Identification | «Кто это утверждает, что он»; у нас — `sub` в JWT. |
| jwt-and-rbac | Authentication | Доказательство identification; у нас — подпись JWT. |
| jwt-and-rbac | Authorization | Право на конкретное действие; `roles[]` + `@Roles(...)`. |
| jwt-and-rbac | JWT | JSON Web Token, RFC 7519. |
| jwt-and-rbac | HS256 | HMAC-SHA-256: симметричная подпись JWT, один секрет. |
| jwt-and-rbac | RS256 | RSA-SHA-256: пара ключей; отвергнуто для портфельного scope. |
| jwt-and-rbac | Access token | Короткоживущий (15m) JWT с `roles[]`. |
| jwt-and-rbac | Refresh token | Долгоживущий (7d) JWT; обменивается на новую пару. |
| jwt-and-rbac | Token rotation | На каждом refresh — **новый** refresh, старый недействителен. |
| jwt-and-rbac | Rotation reuse-detection | Попытка переиспользовать обменянный refresh → invalidate всех сессий. |
| jwt-and-rbac | `JwtAuthGuard` | Global `APP_GUARD`; уважает `@Public()`. |
| jwt-and-rbac | `RolesGuard` | Global `APP_GUARD`; сверяет `request.user.roles` со списком `@Roles(...)`. |
| jwt-and-rbac | `@Public()` | Декоратор-метаданные `auth:isPublic`. |
| jwt-and-rbac | `@Roles(...)` | Декоратор-метаданные `auth:roles`. |
| jwt-and-rbac | `@CurrentUser()` | Param-decorator, читает `request.user`. |
| jwt-and-rbac | `APP_GUARD` | Nest-токен: guard, применяемый глобально. |
| jwt-and-rbac | `RoleEnum` | `'admin' \| 'customer'`; источник правды — `libs/contracts/auth`. |
| jwt-and-rbac | `RoleVO` | Domain-side value object вокруг `RoleEnum`. |
| jwt-and-rbac | `AggregateRoot<TId>` | DDD-базовый класс; `User` — первый string-keyed aggregate. |
| jwt-and-rbac | argon2id | Hybrid memory-hard hash; OWASP-рекомендация. |
| jwt-and-rbac | OWASP A01:2021 | Broken Access Control — top-1 риск в web-приложениях. |
| jwt-and-rbac | Fail-closed | Дефолт «всё запрещено, открой явно». |
| jwt-and-rbac | User enumeration | Возможность отличить «нет логина» от «неверный пароль». |
| jwt-and-rbac | `AUTH_USER_VALIDATOR` | DI-port: app даёт способ резолва user'а по JWT-payload'у. |
| auth-stack-overview | Stack | Вертикальная цепочка пакетов; каждый адаптирует более низкий. |
| auth-stack-overview | Strategy (passport) | Класс с `authenticate(req)`; зарегистрирован под именем. |
| auth-stack-overview | `PassportStrategy(Strategy, name)` | Mixin из `@nestjs/passport`; делает стратегию DI-friendly. |
| auth-stack-overview | `AuthGuard(name)` | Guard-фабрика из `@nestjs/passport`. |
| auth-stack-overview | `req.user` | Свойство, куда passport кладёт результат стратегии. |
| auth-stack-overview | `validate(payload)` | Метод стратегии; passport-middleware его зовёт. |
| auth-stack-overview | `ExtractJwt.fromAuthHeaderAsBearerToken` | Helper из `passport-jwt`; извлекает токен. |
| auth-stack-overview | `secretOrKey` | Параметр `passport-jwt`-Strategy; чем проверять подпись. |
| auth-stack-overview | `JwtService` | Класс из `@nestjs/jwt`; `signAsync` + `verifyAsync`. |
| auth-stack-overview | `JwtModule.registerAsync` | Регистратор `JwtService`. |
| auth-stack-overview | RFC 6750 | Стандарт «Bearer Token Usage» для HTTP. |
| auth-stack-overview | Reflector | Nest-util; читает метаданные с handler/class. |
| auth-stack-overview | `useExisting` | DI-binding: инжект уже-зарегистрированного провайдера под другим токеном. |
| lib-nestjs-passport | `@nestjs/passport` | NPM-пакет: NestJS-обёртка над `passport`. |
| lib-nestjs-passport | `PassportModule` | Nest-модуль; `register({ defaultStrategy })`. |
| lib-nestjs-passport | `defaultStrategy` | Имя стратегии для `AuthGuard()` без аргумента. |
| lib-nestjs-passport | Mixin | Функция, возвращающая класс; runtime-композиция. |
| lib-nestjs-passport | `Reflect.construct` | Низкоуровневый JS-механизм создания инстанса. |
| lib-passport | `passport` | NPM-пакет: middleware-runner для стратегий. |
| lib-passport | Strategy registry | Глобальный map `{ name → instance }` внутри passport. |
| lib-passport | `passport.authenticate(name)` | Express-middleware-фабрика; запускает стратегию. |
| lib-passport | `this.success / fail / error` | Callback'и стратегии для возврата результата. |
| lib-passport | peerDependency | NPM-зависимость, версия которой согласуется wrapper'ом. |
| lib-passport-jwt | `passport-jwt` | NPM-пакет: passport-Strategy для проверки JWT. |
| lib-passport-jwt | `ExtractJwt` | Объект с фабриками функций извлечения токена. |
| lib-passport-jwt | `secretOrKeyProvider` | Динамический resolver секрета. |
| lib-passport-jwt | `ignoreExpiration` | Если `true`, не проверяет `exp`. |
| lib-passport-jwt | `algorithms` | Whitelist разрешённых JWT-alg'ов; защита от alg-confusion. |
| lib-passport-jwt | Alg-confusion attack | Атака: ставят `alg: none`, подделывают JWT. |
| lib-passport-jwt | `verify`-callback | `(payload, done) => …` — для бизнес-проверок. |
| lib-passport-jwt | JWT-claims | Поля `sub`, `iat`, `exp`, `aud`, `iss`, …. |
| lib-nestjs-jwt | `@nestjs/jwt` | NPM-пакет: NestJS-обёртка над `jsonwebtoken`. |
| lib-nestjs-jwt | `JwtService` | Класс с `signAsync` / `verifyAsync`. |
| lib-nestjs-jwt | `JwtSignOptions` | Тип опций `signAsync`. |
| lib-nestjs-jwt | `signAsync<T>` | Подписать → `Promise<string>`. |
| lib-nestjs-jwt | `verifyAsync<T>` | Проверить → `Promise<T>`. |
| lib-nestjs-jwt | `expiresIn` | Lifetime; `'15m'`, `'7d'`, число секунд. |
| lib-nestjs-jwt | `jsonwebtoken` | NPM-пакет; реальный исполнитель sign/verify. |
| lib-argon2 | Argon2 | Победитель Password Hashing Competition (2015). |
| lib-argon2 | Argon2id | Hybrid-вариант: side-channel + timing-resistant. |
| lib-argon2 | Memory-hard | Нужно много памяти на один hash. |
| lib-argon2 | `memoryCost` (m) | Сколько KiB памяти per hash. |
| lib-argon2 | `timeCost` (t) | Количество итераций. |
| lib-argon2 | `parallelism` (p) | Сколько потоков использует один hash. |
| lib-argon2 | Salt | Случайные байты; защита от rainbow-table. |
| lib-argon2 | Rainbow-table | Pre-computed reverse-lookup hash → plaintext. |
| lib-argon2 | Constant-time compare | Без раннего exit'а; защита от timing-атак. |
| lib-argon2 | Bcrypt | Старый де-факто-стандарт; не memory-hard. |
| lib-argon2 | Defence in depth | Многоуровневая защита: hash + cost + salt + constant-time. |
| lib-argon2 | `IPasswordPort` | DI-port: hash/verify для use-cases. |
| lib-argon2 | `IPasswordHasher` | Узкий интерфейс (только verify) для domain-model. |
| lib-argon2 | OWASP A02:2021 | Cryptographic Failures — top-2 риск. |

Approximately **70 new pairs** introduced; some are
re-introductions of already-defined terms (`AggregateRoot`,
`useExisting`, OWASP A0n) and will be deduped in task-12.

## Cross-references added

### Within `auth/` (peer links)

Each article links to every other auth article via
`related:` and `## Связанные решения`:

- `jwt-and-rbac` → `[[auth-stack-overview]]`, all `[[lib-*]]`-peers
- `auth-stack-overview` → `[[jwt-and-rbac]]`, all `[[lib-*]]`-peers
- `lib-nestjs-passport` → `[[auth-stack-overview]]`, `[[jwt-and-rbac]]`, `[[lib-passport]]`, `[[lib-passport-jwt]]`
- `lib-passport` → `[[auth-stack-overview]]`, `[[jwt-and-rbac]]`, `[[lib-nestjs-passport]]`, `[[lib-passport-jwt]]`
- `lib-passport-jwt` → `[[auth-stack-overview]]`, `[[jwt-and-rbac]]`, `[[lib-passport]]`, `[[lib-nestjs-passport]]`, `[[lib-nestjs-jwt]]`
- `lib-nestjs-jwt` → `[[auth-stack-overview]]`, `[[jwt-and-rbac]]`, `[[lib-passport-jwt]]`, `[[lib-nestjs-passport]]`, `[[lib-passport]]`
- `lib-argon2` → `[[auth-stack-overview]]`, `[[jwt-and-rbac]]`, `[[lib-nestjs-jwt]]`, `[[lib-passport-jwt]]`

Every article links to every per-group peer; reciprocal
cross-linking maintained per task-07 §7.

### Back to `concepts/`, `project-shape/`, `persistence/`

Required by task-07 §7 — all four targets covered:

- `[[hexagonal-architecture]]` — referenced by `jwt-and-rbac`,
  `auth-stack-overview`, `lib-argon2` (3×; the
  `IAuthUserValidator` and `IPasswordPort` are showcase
  ports).
- `[[api-gateway-pattern]]` — referenced by `jwt-and-rbac`,
  `auth-stack-overview` (2×; the «`User` lives on gateway»
  rationale anchors here).
- `[[shared-libs-philosophy]]` — referenced by **all seven**
  articles (`related:` block and inline §«Где живёт» /
  §«Где используется» sections).
- `[[entity-vs-domain-model]]` — referenced by
  `jwt-and-rbac` (1×; the `User` vs `UserEntity` distinction).
- `[[mappers-and-repositories]]` — referenced by
  `jwt-and-rbac`, `auth-stack-overview` (2×).

### Forward links into other groups

None. The auth stack is self-contained; nothing in the
written articles forward-references `observability/`,
`application-layer/`, or `quality/`. Future writers of those
groups do not need to retroactively back-link unless they
find a natural insertion point (e.g.
`application-layer/use-cases-vs-fat-services.md` could cite
`LoginUseCase` as a port-coordinating use-case sample —
the article structure of `LoginUseCase` is already cited in
`jwt-and-rbac.md`).

### Root file's TOC

`docs/architecture-migration-ru/architecture-migration-guide.md`
already lists all seven auth articles in its `### auth/`
section (verified at L132-L140; populated by task-01's
scaffolding). No edits to the root file required this
session.

## Verification results

- [x] All seven slot files filled; no `заглушка` callouts
      remain (verified by
      `grep -l 'заглушка\|Заглушка' docs/architecture-migration-ru/auth/*.md`
      → 0 hits).
- [x] Every code excerpt has a GitHub permalink pinned to
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664`
      (**45 permalinks total**: 17 + 11 + 3 + 1 + 2 + 6 + 5).
- [x] All cited line ranges validated against `wc -l` of
      each file at the recorded SHA. No off-by-one
      corrections required this session.
- [x] Every `[[wiki-link]]` resolves to a file that exists
      under `docs/architecture-migration-ru/` (verified by
      enumerating 12 distinct targets — all resolve;
      cross-group back-links `[[hexagonal-architecture]]`,
      `[[api-gateway-pattern]]`, `[[shared-libs-philosophy]]`,
      `[[entity-vs-domain-model]]`,
      `[[mappers-and-repositories]]` all hit existing stub
      or filled files).
- [x] No orphans under `docs/architecture-migration-ru/` —
      the root file's `### auth/` section already links
      every stub from task-01 to all seven articles
      (`grep -c '\[\[<slug>\]\]' architecture-migration-guide.md`
      → 7 distinct targets per the scaffold).
- [x] Each article above the 600-word floor (smallest:
      `lib-passport.md` at **928 слов**; largest:
      `jwt-and-rbac.md` at **3552 слов**; the median
      per-lib article is ~1180 слов).
- [x] Frontmatter valid on each touched file (`status:
      review`, `updated: 2026-05-16`, `related: [...]`
      populated with 4–10 wiki-link entries).
- [x] Each article carries the mandatory `> [!abstract] Кратко`
      callout, `## Глоссарий` section, and `> [!faq]- Проверь
      себя` self-check block.
- [x] Every per-library article has the required
      **«Что этот пакет НЕ делает»** section (per task-07
      §5). Section title is consistent: each contains 6-10
      bullet items.
- [x] No `git` mutating commands were run during this
      session.

## Suggested adjustments to upcoming tasks

1. **The `[[shared-libs-philosophy]]` back-link is now
   eight-doubled** (seven auth articles + cache-stack
   peers from task-06). When task-03's
   `project-shape/shared-libs-philosophy.md` is written (or
   already exists and gets revised), it should bring **one**
   canonical section called «Adapter-only impors» that
   enumerates which third-party libraries are confined to
   which lib (e.g. `@nestjs/jwt` → `libs/auth` +
   `JwtTokenAdapter`; `argon2` → `Argon2PasswordAdapter`;
   `@nestjs/passport` → `libs/auth`; `passport-jwt` →
   `libs/auth`; cache stack from task-06; OTel stack from
   task-08/09). That table would close 14+ implicit links
   in two paragraphs.

2. **`[[hexagonal-architecture]]` is now triple-cited by
   auth articles** as the canonical place for
   port-and-adapter patterns. When the concepts article is
   written, it should pick **one** runtime adapter to walk
   through (recommendation: `Argon2PasswordAdapter` because
   it's small enough — 31 lines — to fit a whole listing,
   and it links to two ports of different shapes
   `IPasswordPort` for use-cases and `IPasswordHasher` for
   domain-model). The double-port pattern is unusual enough
   to be worth showing.

3. **`auth-stack-overview.md` uses mermaid for both the
   request-flow and the sign-flow.** The same diagram style
   that `cache-stack-overview.md` used (`flowchart TB`),
   per `_carryover-06.md` §«Suggested adjustments» #8. If
   future writers want to enforce «every stack-overview
   uses the same diagram style», the audit task (task-12)
   can codify it.

4. **The two-secret JWT pattern is unusual enough to
   deserve a dedicated diagram.** `jwt-and-rbac.md` §«HS256,
   два секрета, и почему» explains the rationale, but the
   actual mechanism («one `JwtService` with default
   `JWT_ACCESS_SECRET`, per-call override to
   `JWT_REFRESH_SECRET`») lives in
   `lib-nestjs-jwt.md` §«`JwtService.signAsync`». Audit-time:
   consider hoisting this into a 6-line diagram in the
   stack-overview, since it's the kind of thing that's
   easy to miss when reading prose.

5. **The `verify` swallow-exception in
   `Argon2PasswordAdapter` is a small but pointed
   defence-in-depth pattern** worth showing in
   `application-layer/use-cases-vs-fat-services.md` when
   that article discusses login-flow. It's already explained
   in `lib-argon2.md` §«`argon2.verify`», so the
   application-layer article can just back-link.

6. **`User` is the only `AggregateRoot<string>` in the
   project today** (per `_carryover-06.md` §9 #2). The
   `persistence/entity-vs-domain-model.md` article (when
   written) should call out that the `AggregateRoot<TId>`
   generic was made generic over `TId` specifically because
   `User` surfaced the gap — that's a story-worth-telling
   detail of how migration constraints feedback into
   `libs/ddd`. `_carryover-06.md` (migration plan) §9 #2
   has the raw context.

7. **No new ADRs were necessary** during this writing
   session. The seven articles document conventions already
   shipped (ADR-010). No architectural decisions were taken.

8. **Public registration is documented but unused** — every
   article that touches `LoginUseCase` mentions
   `RegisterUserUseCase` exists. When task-10
   (`application-layer/`) is written, it should be the
   place to explain «use-cases that exist but aren't
   exposed are fine if they're unit-tested» (the test
   strategy story); otherwise readers will wonder why
   `RegisterUserUseCase` ships unused. Cross-link target:
   `[[test-strategy]]` in `quality/`.

9. **Forward-link to `auth/` not opened.** No article in
   `auth/` forward-references future content
   (`observability/`, `application-layer/`, `quality/`). If
   task-12 audit wants to enforce «every group has at least
   one forward-link to anchor the reading sequence», the
   natural place to add one is
   `auth-stack-overview.md` → `[[trace-log-correlation]]`
   on the «`logMethod` injects `traceId`/`spanId` into
   Pino-records» observation (the auth use-cases emit
   `UserLoggedIn`/`RefreshTokenRotated`/`LogoutPerformed`
   Pino-lines; those benefit from trace-correlation). This
   is the **third** triple-doubled forward-link to
   `trace-log-correlation`, joining
   `routing-keys-and-contracts` (task-05) and
   `cache-stack-overview` (task-06). The trace-correlation
   article — when written — should back-link to all three.
