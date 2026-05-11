# _carryover-06.md — Build authentication and authorization from scratch (Phase 3)

> Generated 2026-05-10 by the task-06 session on branch
> `RIS-30-Architecture-migration-Phase-6-Build-authentication-and-authorization-from-scratch`.
> The next task (`task-07`) reads this file as its first action and fails
> fast if it is missing.

## 1. Entry-gate result

`yarn install`, `yarn build` (4 apps), `yarn lint`, `yarn test:unit` were all
green at the start of the session. Build artefacts and snapshot baseline are
unchanged from `_carryover-05.md`'s reported state.

## 2. Files created — paths + roles

### Cross-service contracts (framework-free)

| Path | Role |
|------|------|
| `libs/contracts/auth/role.enum.ts` | `RoleEnum { ADMIN = 'admin', CUSTOMER = 'customer' }` — source of truth. |
| `libs/contracts/auth/current-user.dto.ts` | `ICurrentUser { id, email, roles }` interface. |
| `libs/contracts/auth/jwt-payload.dto.ts` | `IJwtAccessPayload`, `IJwtRefreshPayload` interfaces. |
| `libs/contracts/auth/index.ts` | Barrel. |

`libs/contracts/index.ts` re-exports `./auth`.

### `libs/auth/` — Nest framework glue

| Path | Role |
|------|------|
| `libs/auth/auth.module.ts` | `AuthModule.forRootAsync({ imports, providers, exports })` registers `PassportModule`, `JwtModule`, `JwtStrategy`, `JwtAuthGuard`, `RolesGuard`. Global module. |
| `libs/auth/jwt.strategy.ts` | `passport-jwt` strategy; verifies access JWT, delegates user lookup to `AUTH_USER_VALIDATOR`. |
| `libs/auth/auth-user-validator.port.ts` | `IAuthUserValidator` interface + `AUTH_USER_VALIDATOR` Symbol — apps bind this. |
| `libs/auth/jwt-auth.guard.ts` | Wraps `AuthGuard('jwt')` and respects `@Public()`. |
| `libs/auth/roles.guard.ts` | Reflects `@Roles(...)` and checks `request.user.roles`. |
| `libs/auth/public.decorator.ts` | `@Public()` route metadata to bypass `JwtAuthGuard`. |
| `libs/auth/roles.decorator.ts` | `@Roles(...roles: RoleEnum[])`. |
| `libs/auth/current-user.decorator.ts` | `@CurrentUser()` parameter decorator. |
| `libs/auth/role.enum.ts` | Runtime re-export of `RoleEnum` from contracts. |
| `libs/auth/index.ts` | Public API barrel. |

Path alias `@retail-inventory-system/auth` registered in `tsconfig.json`,
`jest.unit.config.js`, and `jest.e2e.config.js`.

### Gateway-side `apps/api-gateway/src/modules/auth/`

| Path | Role |
|------|------|
| `domain/user.model.ts` | `User extends AggregateRoot<string>`. Constructor invariants (email/passwordHash/roles non-empty). Factory methods `register()` / `rehydrate()`. Methods `assignRole`, `revokeRole`, `rotateRefreshTokenHash`, `validatePassword`, `recordLoggedIn`. |
| `domain/role.model.ts` | `RoleVO` value object wrapping `RoleEnum`; rejects unknown role on construction. |
| `domain/events/user-registered.event.ts` | Domain event — fires on registration. |
| `domain/events/user-logged-in.event.ts` | Domain event — fires on login. |
| `domain/events/index.ts` | Barrel. |
| `application/ports/user.repository.port.ts` | `IUserRepositoryPort` + `USER_REPOSITORY` symbol. |
| `application/ports/token.port.ts` | `ITokenPort` + `TOKEN_SERVICE` symbol; `IIssuedTokens`. |
| `application/ports/password.port.ts` | `IPasswordPort` + `PASSWORD_HASHER` symbol. |
| `application/ports/index.ts` | Barrel. |
| `application/use-cases/login.use-case.ts` | Validates creds, issues tokens, persists refresh-hash, records `UserLoggedIn`. |
| `application/use-cases/refresh-token.use-case.ts` | Verifies refresh JWT (sig + hash); rotation reuse clears hash + 401. |
| `application/use-cases/logout.use-case.ts` | Clears refresh-hash. |
| `application/use-cases/register-user.use-case.ts` | Conflict-aware user creation; default role `CUSTOMER`. |
| `application/use-cases/validate-user.use-case.ts` | `IAuthUserValidator` impl — used by `libs/auth` JWT strategy. |
| `application/use-cases/index.ts` | Barrel. |
| `application/dto/login.command.ts` / `refresh.command.ts` / `current-user.view.ts` / `index.ts` | Command/query DTOs. |
| `infrastructure/persistence/user.entity.ts` | TypeORM entity. CHAR(36) UUID id; `simple-array` roles; nullable `refreshTokenHash`; soft-delete via `@DeleteDateColumn`. |
| `infrastructure/persistence/user.mapper.ts` | Entity ↔ domain mapper. Filters unknown role strings. |
| `infrastructure/persistence/user-typeorm.repository.ts` | `UserTypeormRepository implements IUserRepositoryPort`. |
| `infrastructure/jwt/jwt-token.adapter.ts` | `JwtTokenAdapter implements ITokenPort`. Uses `JwtService` for access (default secret) and refresh (separate secret). |
| `infrastructure/argon2/argon2-password.adapter.ts` | `argon2id` hash/verify with cost params from env. |
| `infrastructure/auth.module.ts` | Wires the `libs/auth` `forRootAsync` (binding `AUTH_USER_VALIDATOR` → `ValidateUserUseCase` and the `USER_REPOSITORY` symbol) plus password adapter, token adapter, controllers, and use cases. |
| `presentation/auth.controller.ts` | `POST /auth/login` (Public), `POST /auth/refresh` (Public), `POST /auth/logout`, `GET /auth/me`. Class-validator + Swagger. |
| `presentation/auth-admin.controller.ts` | `GET /auth/admin/ping` — admin-only smoke endpoint. |
| `presentation/dto/{login.request,refresh.request,token.response,current-user.response,index}.dto.ts` | Request/response DTOs with `class-validator` rules + Swagger metadata. |

### Migration

| File | Notes |
|------|-------|
| `migrations/1778419765133-CreateUserTable.ts` | Class `CreateUserTable1778419765133`. Creates `user` table with `CHAR(36)` id, unique `email` (case-insensitive via `utf8mb4_unicode_ci`), `password_hash`, `simple-array` `roles`, nullable `refresh_token_hash`, `created_at`/`updated_at`/`deleted_at` columns. |

### Specs

| File | Coverage |
|------|----------|
| `apps/api-gateway/src/modules/auth/application/use-cases/spec/test-doubles.ts` | `InMemoryUserRepository`, `FakeHasher`, `FakeTokenAdapter`. |
| `apps/api-gateway/src/modules/auth/application/use-cases/spec/login.use-case.spec.ts` | Valid creds, missing user, bad password. |
| `apps/api-gateway/src/modules/auth/application/use-cases/spec/refresh-token.use-case.spec.ts` | Valid rotation, rotation reuse → 401 + hash cleared, signature/expiry failure, soft-deleted user. |
| `apps/api-gateway/src/modules/auth/application/use-cases/spec/validate-user.use-case.spec.ts` | Active user, missing user, soft-deleted user. |
| `apps/api-gateway/src/modules/auth/application/use-cases/spec/register-user.use-case.spec.ts` | Default role, explicit role list, case-insensitive uniqueness conflict. |
| `apps/api-gateway/src/modules/auth/application/use-cases/spec/logout.use-case.spec.ts` | Successful logout clears hash; missing user → 404. |

### E2E

| File | Coverage |
|------|----------|
| `test/auth.e2e-spec.ts` (new) | 401 on unauthed `POST /api/order` and `GET /api/product/:id/stock`; login bad-password → 401; login good → 200 + tokens; bearer access → 200; refresh-token rotation invalidates the original refresh; customer hitting admin route → 403; admin hitting it → 200; logout → 200, subsequent refresh → 401. 10 tests, all pass. |
| `test/system-api.e2e-spec.ts` (modified) | Added `customerAccessToken` via login in `beforeAll`; introduced `httpClient()` helper that returns a supertest agent with the bearer header pre-set; replaced 24 raw `supertest(...)` call sites with the helper. All 24 existing tests still pass with their existing snapshots. |

### Other

| File | Role |
|------|------|
| `scripts/test-db-seed.ts` | Now also inserts `admin@example.com` / `admin1234` (`[admin, customer]`) and `customer@example.com` / `customer1234` (`[customer]`) with argon2id-hashed passwords. Stable UUIDs for fixture stability. |
| `.env.local` | New env vars for JWT + argon2 (development-only secrets, ≥ 32 chars). |
| `libs/config/config-module.config.ts` | Joi validation for `JWT_*` and `AUTH_ARGON2_*` env vars; rejects same-secret access/refresh pairs. |
| `apps/api-gateway/src/app/app.module.ts` | Registers `DatabaseModule.forRoot([UserEntity])`, `AuthModule`, and global `APP_GUARD` providers (`JwtAuthGuard`, `RolesGuard`). |
| `apps/api-gateway/src/modules/retail/presentation/order.controller.ts` | `@Roles(RoleEnum.CUSTOMER, RoleEnum.ADMIN)` + `@ApiBearerAuth`. |
| `apps/api-gateway/src/modules/inventory/presentation/product.controller.ts` | Same. |
| `libs/ddd/aggregate-root.base.ts` | Threaded the `TId` generic through `_domainEvents: DomainEvent<TId>[]` and `addDomainEvent` / `pullDomainEvents`. The existing `FakeAggregate extends AggregateRoot<number>` test still passes verbatim. This is the first string-keyed aggregate (User), which surfaced the gap. |

### Documentation

| File | Change |
|------|--------|
| `README.md` | New "Authentication" section (login/refresh/logout flow, env vars, role catalogue, seed users, observability hook). Added `auth` row to "Shared libraries" table. Added `/api/auth/*` routes to the API surface block. |
| `CLAUDE.md` | Added `libs/auth/` row to the directory map; added `modules/auth/` block to the API Gateway service-structure section; added "Authentication conventions (gateway)" subsection; added `auth/` sub-area to the contracts library bullet; added a new `@retail-inventory-system/auth` library bullet; struck the "no authentication today" Known Issue; bumped the next free ADR number from 010 to 011. |
| `docs/adr/010-jwt-rbac-at-the-gateway.md` | New ADR. **Status: Accepted.** Covers JWT-vs-sessions/OAuth, argon2id-vs-bcrypt, refresh-token rotation policy, where the User aggregate lives, "all routes protected by default", deferred cross-service token verification, deferred public registration, and the smoke endpoint. |

## 3. Migration filename

`migrations/1778419765133-CreateUserTable.ts` — class
`CreateUserTable1778419765133`. Timestamp ordering is consistent with the
two pre-existing migrations.

## 4. Seed users

| Email | Password | Roles | UUID |
|-------|----------|-------|------|
| `admin@example.com` | `admin1234` | `admin`, `customer` | `00000000-0000-4000-a000-000000000001` |
| `customer@example.com` | `customer1234` | `customer` | `00000000-0000-4000-a000-000000000002` |

Hashed at seed time with the env-tuned argon2id parameters. UPSERT via
`ON DUPLICATE KEY UPDATE` so re-seeding refreshes the hash and clears the
refresh-token hash (matching `yarn test:e2e` expectations).

## 5. Public registration

**Deferred.** `RegisterUserUseCase` exists and is unit-tested but is **not**
mounted on a public HTTP route. Reason: a live registration endpoint
requires rate-limiting, email verification, and CAPTCHA before it is safe
to expose; none of those are in scope. Local development uses
`yarn test:seed`. ADR-010 §7 captures the decision.

## 6. Hash algorithm

**`argon2id`** via the `argon2` npm package (v0.44.0). Cost parameters
default to OWASP 2024 minimums (`memoryCost: 19_456` KiB, `timeCost: 2`,
`parallelism: 1`); tunable per-environment via `AUTH_ARGON2_*`. Rationale in
ADR-010 §2. No maintainer override requested.

## 7. Verification results

```
$ yarn install
➤ YN0000: · Done in 2s 215ms

$ yarn build
webpack 5.106.0 compiled successfully in 8376 ms   # api-gateway
webpack 5.106.0 compiled successfully in 9601 ms   # inventory-microservice
webpack 5.106.0 compiled successfully in 9061 ms   # retail-microservice
webpack 5.106.0 compiled successfully in 9341 ms   # notification-microservice

$ yarn lint
# (no output — clean exit code 0)

$ yarn test:unit
Test Suites: 16 passed, 16 total
Tests:       85 passed, 85 total
Snapshots:   0 total
Time:        28.131 s

$ yarn test:e2e
Test Suites: 2 passed, 2 total
Tests:       34 passed, 34 total
Snapshots:   42 passed, 42 total
Time:        10.958 s
```

### Smoke (live stack via `yarn start:prod:*`)

```
$ curl -s -o /tmp/curl1.body -w "HTTP %{http_code}\n" \
    -X POST http://localhost:3000/api/order \
    -H "Content-Type: application/json" \
    -d '{"customerId":1,"products":[{"productId":1,"quantity":1}]}'
HTTP 401
{"message":"Unauthorized","statusCode":401}

$ curl -s -X POST http://localhost:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"customer@example.com","password":"customer1234"}'
HTTP 200
{"accessToken":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...","refreshToken":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...","expiresIn":900}

$ curl -s -X POST http://localhost:3000/api/order \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <access-token>" \
    -d '{"customerId":1,"products":[{"productId":1,"quantity":1}]}'
HTTP 201
{"orderId":5,"status":"pending","message":"Order successfully created"}
```

All seven verification gates pass.

`package.json` lists `@nestjs/jwt@^11.0.2`, `@nestjs/passport@^11.0.5`,
`passport@^0.7.0`, `passport-jwt@^4.0.1`, `argon2@^0.44.0` as runtime deps,
plus `@types/passport-jwt@^4.0.1` as a dev dep.

## 8. ADR numbers assigned

- **ADR-010** — JWT authentication and RBAC at the API gateway. Status:
  Accepted. The optional separate "argon2 over bcrypt" ADR called out in
  the task script was folded into ADR-010 §2 — too short to stand on its
  own. CLAUDE.md's "next free ADR" counter advanced to **011**.

## 9. Unexpected findings

1. **Project lint convention requires the `Enum` suffix on enum names.**
   Task-06 spec says `enum Role { ADMIN, CUSTOMER }`, but
   `eslint.config.mjs` enforces
   `@typescript-eslint/naming-convention` with
   `regex: '[A-Za-z]Enum$'` for enums. Resolution: enum is named
   `RoleEnum`. Decorator and value-object names stay as `Roles` and
   `RoleVO` (those rules don't apply to those forms). Documented in the
   Authentication conventions section of CLAUDE.md and in ADR-010.

2. **`libs/ddd/aggregate-root.base.ts` was not generic over event
   aggregateId type.** `AggregateRoot<TId>` had
   `_domainEvents: DomainEvent[]`, which defaulted to
   `DomainEvent<number>` and rejected `DomainEvent<string>`. Threading
   `TId` through the field/method signatures unblocked the User
   aggregate (string id) without breaking the existing
   `FakeAggregate extends AggregateRoot<number>` test. This is the
   first string-keyed aggregate in the project, so this gap was
   latent until task-06.

3. **`RETAIL_ORDER_GET` payload still has no `correlationId`.** Pre-task-05
   it was a bare numeric id; carryover-05 §9 #2 already noted the gap is
   queued for the publisher-port introduction (task-08/09). Touching it
   here would have rippled into the retail microservice's
   `@MessagePattern` handler, which is out of scope. No change.

4. **Existing system-api E2E tests had to be updated.** Twenty-four
   pre-task-06 calls used `supertest(apiGatewayApp.getHttpServer())`
   directly. After the global guard, every non-public route 401s. Fix
   was a single `httpClient()` helper that wraps `supertest.agent(...)`
   with the bearer token pre-set. No snapshot drift — all 42 snapshots
   match the pre-task-06 baseline byte-for-byte.

## 10. Suggested adjustments to task-07 (notification microservice)

1. **Notification can subscribe to `UserLoggedIn` if the business wants
   login alerts.** The event is published in-process today (Pino log
   line); piping it to RabbitMQ requires a publisher port (task-08/09)
   or a direct emit from `LoginUseCase`. If task-07 wants the wiring,
   extend the gateway side first: add an `auth.user-logged-in` routing
   key and emit from `LoginUseCase`. Otherwise, keep auth events as
   structured logs only — no new infra needed.

2. **Adopting `@retail-inventory-system/auth` in the notification
   microservice is a no-op today.** Notification has no HTTP surface and
   no RPC handlers that need the bearer principal. When it gains those
   (e.g. a "fetch my notifications" endpoint), re-use `AuthModule` in
   read-only mode (no `JwtModule` registration needed — only verify,
   don't issue) — the contract shape `IJwtAccessPayload` is already in
   `@retail-inventory-system/contracts/auth`.

3. **Reuse the seeded users for notification fixtures.** Don't seed new
   users — `customer@example.com` is enough to drive any
   notification-targeting test.

## 11. Open follow-ups (post-migration)

1. **Public registration endpoint** — when business needs it; pair with
   rate-limiting and email-verification.
2. **`/auth/forgot-password` + `/auth/reset-password`** — needs an
   outbound email path (notification microservice or external SMTP).
3. **Rate-limiting on `/auth/login`** — `@nestjs/throttler` against the
   gateway, scoped to IP + email pair.
4. **Token verification by downstream microservices** — sequenced after
   the publisher-port introduction in task-08/09. Add an `authContext`
   field to the RPC payloads and mount `JwtAuthGuard` on the RPC
   transport. ADR-010 §6 captures the trajectory.
5. **Refresh-token revocation list** — today, "logout" only invalidates
   the current refresh hash. A truly stolen access token (max 15 min
   lifetime) cannot be revoked. If lifetime tightens or a high-value
   role is added, introduce a per-`jti` deny-list (Redis with TTL =
   token lifetime).
6. **Move JWT secrets to a real secrets manager** — currently sourced
   from `.env.local` (fine for dev). Production needs Vault / AWS KMS /
   GCP Secret Manager.
7. **Switch `email` column collation to a case-insensitive citext-style
   index.** MySQL doesn't have `CITEXT`; today the table uses
   `utf8mb4_unicode_ci` collation, which gets us case-insensitive
   uniqueness through the standard collation rules. If we migrate to
   PostgreSQL, swap to `CITEXT`.
