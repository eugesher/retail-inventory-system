# task-06 — Build authentication and authorization from scratch (Phase 3)

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-05.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: the API gateway is in the per-module
  hexagonal layout (`modules/{retail,inventory}/`), use cases call
  through ports, the observability tracer is wired. The repository has
  **no authentication today** (no `@nestjs/jwt`, no `passport`, no
  `auth/` folder, no User entity). This task builds JWT + RBAC end-to-
  end and establishes `@retail-inventory-system/auth` so future
  microservices can validate tokens uniformly. It is the first task
  that actually adds a feature rather than restructuring existing
  code; the user explicitly asked for it as a separate, fully detailed
  step (see `_carryover-01.md`).

## Prerequisites

- [ ] `_carryover-05.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] `apps/api-gateway/src/modules/` exists from task-05.
- [ ] `@retail-inventory-system/contracts`,
  `@retail-inventory-system/database`,
  `@retail-inventory-system/observability` exist from tasks 03–04.

## Goal

Stand up authentication (JWT access + refresh tokens) and role-based
authorization (RBAC) at the API gateway, with shared primitives in
`@retail-inventory-system/auth` so microservices can later validate
tokens off the gateway. Every gateway HTTP route becomes protected by
default; `/auth/login` and `/auth/refresh` are explicitly `@Public()`.
Two roles are seeded: `admin` and `customer`. Existing routes
(`POST /api/order`, `PUT /api/order/:id/confirm`,
`GET /product/:productId/stock`) gain role guards
(`@Roles(Role.CUSTOMER, Role.ADMIN)` for orders;
`@Roles(Role.CUSTOMER, Role.ADMIN)` for stock — record any
deviation in the ADR). The User aggregate lives in the gateway's
`modules/auth/`; user state persists to MySQL through a dedicated
TypeORM entity and migration.

## Steps

1. **Add dependencies** at the workspace root:
   ```
   yarn add @nestjs/jwt @nestjs/passport passport passport-jwt argon2
   yarn add -D @types/passport-jwt
   ```
   `argon2` is preferred over `bcrypt` (modern, memory-hard, OWASP-
   recommended). If a maintainer prefers `bcrypt`, swap it in
   `task-06` and call out the choice in the ADR; the migration is
   the right time to lock the choice in.

2. **Extend Joi config schema.** In
   `libs/config/config-module.config.ts` add:
   - `JWT_ACCESS_SECRET` — required, string min 32.
   - `JWT_ACCESS_EXPIRES_IN` — default `'15m'`, string.
   - `JWT_REFRESH_SECRET` — required, string min 32, **distinct**
     from access secret (rotated independently).
   - `JWT_REFRESH_EXPIRES_IN` — default `'7d'`, string.
   - `AUTH_ARGON2_MEMORY_COST` — default `19_456`, number (kib —
     OWASP 2024 minimum).
   - `AUTH_ARGON2_TIME_COST` — default `2`, number.
   - `AUTH_ARGON2_PARALLELISM` — default `1`, number.
   Document each in the README "Authentication" section.

3. **Build `@retail-inventory-system/auth`** as a Nest library
   (`libs/auth/`):
   - `auth.module.ts` — `forRootAsync()` that registers the
     `JwtModule` (with the access secret), `PassportModule`, the
     `JwtStrategy`, `JwtAuthGuard`, and `RolesGuard`.
   - `jwt.strategy.ts` — `passport-jwt` strategy that extracts
     `Authorization: Bearer <token>`, verifies with the access
     secret, and attaches the decoded payload to `request.user`.
   - `jwt-auth.guard.ts` — wraps `AuthGuard('jwt')` and respects
     the `@Public()` decorator.
   - `roles.guard.ts` — reflects `@Roles(...)` metadata and checks
     `request.user.roles`.
   - `current-user.decorator.ts` — `@CurrentUser()` parameter
     decorator returning `request.user`.
   - `public.decorator.ts` — `@Public()` route metadata to bypass
     `JwtAuthGuard`.
   - `roles.decorator.ts` — `@Roles(...roles: Role[])`.
   - `role.enum.ts` — `enum Role { ADMIN, CUSTOMER }` (mirrors the
     contract enum from `libs/contracts/auth/`; cross-reference in
     the ADR).
   - `index.ts` — re-export the public API.

4. **Add cross-service auth contracts** in
   `libs/contracts/src/auth/`:
   - `current-user.dto.ts` — `{ id, email, roles[] }` shape.
   - `jwt-payload.dto.ts` — `{ sub, email, roles[], iat, exp, jti }`.
   - `role.enum.ts` — re-exported by `libs/auth` for runtime use;
     `libs/contracts/auth/role.enum.ts` is the source of truth.
   These contracts are framework-free so future microservices that
   want to validate tokens off the gateway can depend on them
   without pulling Nest into the contract layer.

5. **Persist users.** Add a `User` TypeORM entity at
   `apps/api-gateway/src/modules/auth/infrastructure/persistence/user.entity.ts`:
   ```
   @Entity('user')
   class UserEntity {
     id (uuid v4 primary)
     email (unique, citext / case-insensitive)
     passwordHash (varchar 255)
     roles (simple-array, default ['customer'])
     refreshTokenHash (varchar 255, nullable) // current valid refresh; rotated on refresh
     createdAt, updatedAt, deletedAt
   }
   ```
   Add a TypeORM migration under `migrations/` named
   `<timestamp>-CreateUserTable.ts`. Update
   `apps/api-gateway/src/app/app.module.ts` to register the User
   entity via `TypeOrmModule.forRoot(...)` — the gateway does not
   currently load TypeORM, so this is the first DB-touching change
   inside the gateway. (Alternative: keep the gateway DB-free and
   put the User aggregate in the retail microservice — rejected
   here because auth is a gateway concern; document the trade-off
   in the ADR.)

6. **Build the auth module under the gateway** at
   `apps/api-gateway/src/modules/auth/`:

   **Domain.**
   - `domain/user.model.ts` — pure class with constructor invariants
     (email is non-empty, valid format; `roles` non-empty;
     `passwordHash` non-empty). Methods: `assignRole(role)`,
     `revokeRole(role)`, `rotateRefreshTokenHash(hash)`,
     `validatePassword(candidate, hasher)` returning a Promise.
   - `domain/role.model.ts` — value-object wrapping the role enum;
     enforces "unknown role" rejection on construction.
   - `domain/events/user-registered.event.ts`,
     `user-logged-in.event.ts` (fires for audit; consumed by
     notification in task-07 if business wants login alerts).

   **Application.**
   - `application/ports/user.repository.port.ts` —
     `findByEmail(email)`, `findById(id)`, `save(user)`,
     `softDelete(id)`. DI symbol `USER_REPOSITORY`.
   - `application/ports/token.port.ts` —
     `issueAccessToken(payload)`, `issueRefreshToken(payload)`,
     `verifyRefresh(token)`. DI symbol `TOKEN_SERVICE`.
   - `application/ports/password.port.ts` — `hash(plain)`,
     `verify(hash, plain)`. DI symbol `PASSWORD_HASHER`.
   - `application/use-cases/`:
     - `register-user.use-case.ts` — creates a user, default role
       `customer`. Used for seed; the public registration endpoint
       is **deferred** unless the user explicitly opts in (record
       the choice in `_carryover-06.md`).
     - `login.use-case.ts` — validates credentials, issues access +
       refresh tokens, persists the refresh-token hash on the user.
     - `refresh-token.use-case.ts` — verifies the incoming refresh
       token (signature + hash match against persisted), rotates,
       issues a new access token (and a new refresh token —
       refresh-token rotation, not reuse).
     - `validate-user.use-case.ts` — used by the JWT strategy's
       `validate()` callback to load and check the user is active.
     - `logout.use-case.ts` — clears the user's
       `refreshTokenHash` so any in-flight refresh fails.
   - `application/dto/login.command.ts`,
     `refresh.command.ts`, `current-user.view.ts`.

   **Infrastructure.**
   - `infrastructure/persistence/user.entity.ts` (from step 5).
   - `infrastructure/persistence/user.mapper.ts`
     (entity ↔ domain).
   - `infrastructure/persistence/user-typeorm.repository.ts`
     implements `UserRepositoryPort` extending
     `BaseTypeormRepository`.
   - `infrastructure/jwt/jwt-token.adapter.ts` implements
     `TokenPort` using `@nestjs/jwt`.
   - `infrastructure/argon2/argon2-password.adapter.ts` implements
     `PasswordPort`.
   - `infrastructure/jwt/jwt.strategy.ts` re-exports the
     `libs/auth` strategy with the gateway-specific
     `validate()` callback delegating to
     `ValidateUserUseCase`.
   - `infrastructure/auth.module.ts` wires every binding.

   **Presentation.**
   - `presentation/auth.controller.ts` —
     - `POST /auth/login` — `@Public()`,
       body `LoginRequestDto`, returns `TokenResponseDto`
       (`{ accessToken, refreshToken, expiresIn }`).
     - `POST /auth/refresh` — `@Public()`,
       body `RefreshRequestDto`, returns `TokenResponseDto`.
     - `POST /auth/logout` — protected, calls
       `LogoutUseCase`.
     - `GET /auth/me` — protected, returns
       `CurrentUserView`.
   - `presentation/dto/{login.request,refresh.request,token.response,current-user.response}.dto.ts`
     — `class-validator` rules; OpenAPI tags
     (`@nestjs/swagger`) so the Scalar reference at
     `/api/reference` shows them.

7. **Apply guards globally.** In
   `apps/api-gateway/src/app/app.module.ts` register the
   `JwtAuthGuard` and `RolesGuard` as global providers via
   `APP_GUARD`. Add `@Public()` to the bootstrap routes that
   exist (login/refresh). Annotate existing protected routes with
   `@Roles(...)`:
   - `POST /api/order` → `@Roles(Role.CUSTOMER, Role.ADMIN)`.
   - `PUT /api/order/:id/confirm` →
     `@Roles(Role.CUSTOMER, Role.ADMIN)`.
   - `GET /product/:productId/stock` →
     `@Roles(Role.CUSTOMER, Role.ADMIN)`.
   Existing controllers may want a `@CurrentUser()` parameter;
   wire it where it's useful (e.g. attach `userId` to the order
   create command — coordinate with task-09).

8. **Seed users and roles** for development and E2E. Extend
   `scripts/test-db-seed.ts` to insert two users:
   - `admin@example.com` / `admin1234` / `[admin, customer]`
   - `customer@example.com` / `customer1234` / `[customer]`
   Hashes use `argon2` with the cost params from step 2. Add a
   note in `scripts/seeds/` if a SQL seed file is preferred; SQL
   seeds are awkward for argon2 hashes since they're per-install.
   Recommended: insert via a TypeScript helper.

9. **E2E coverage.** Extend `test/system-api.e2e-spec.ts` (or
   create `test/auth.e2e-spec.ts` if it grows beyond ~150 lines):
   - Unauthenticated request to `POST /api/order` → 401.
   - Login with bad password → 401.
   - Login with good password → 200 + tokens.
   - Authenticated request with valid `Bearer` token → 200.
   - Refresh-token rotation: refresh once, then try the original
     refresh token → 401 (rotation invalidated it).
   - Role guard: a customer hitting an admin-only route → 403.
     (Add at least one admin-only test endpoint if no production
     route is admin-only yet — e.g. `GET /admin/users`. Document
     the choice.)
   - Logout → 200; subsequent refresh → 401.

10. **Unit tests.** One spec per use case:
    - `login.use-case.spec.ts` (valid creds, bad creds, deleted
      user).
    - `refresh-token.use-case.spec.ts` (valid, expired, rotation
      reuse, signature mismatch).
    - `validate-user.use-case.spec.ts`.
    - `register-user.use-case.spec.ts` (uniqueness violation,
      successful create).
    - `logout.use-case.spec.ts`.
    Use cases take in-memory port doubles; no NestJS test module
    is required.

11. **Observability hooks.** Auth events (`UserLoggedIn`,
    `LoginFailed`, `RefreshTokenRotated`, `LogoutPerformed`) emit
    Pino log lines at `info`/`warn` with `userId` /
    `correlationId` fields. They do **not** publish to RabbitMQ
    by default; publishing is wired in task-07 if notification
    needs them.

## Documentation updates required

- [ ] `README.md`: add a top-level "Authentication" section
  documenting:
  - The login/refresh flow (sequence diagram in mermaid or text).
  - Required env vars (`JWT_*`, `AUTH_ARGON2_*`).
  - Role catalogue (`admin`, `customer`).
  - Refresh-token rotation policy.
  - Logout semantics.
  - How to seed local users (`yarn test:seed`).
  Also: add the Authentication note to the existing "Logging &
  Observability" section so readers know auth events are logged.
- [ ] `CLAUDE.md`:
  - Strike "no auth implementation" from any "Known Issues" line.
  - Update "Message patterns" if any new auth-related pattern is
    introduced (none expected today).
  - Update "Shared Libraries" with
    `@retail-inventory-system/auth` and
    `@retail-inventory-system/contracts/auth`.
  - Add a "Authentication conventions" subsection: argon2 over
    bcrypt, refresh-token rotation, RBAC via `@Roles(...)` and
    `@CurrentUser()`, every route protected by default.
- [ ] `docs/adr/NNN-jwt-rbac-at-the-gateway.md`: new ADR. Status:
  Accepted. Cover:
  - Why JWT (vs session cookies, vs OAuth provider).
  - Why argon2 (vs bcrypt).
  - Refresh-token rotation policy and rationale.
  - Where the User aggregate lives (gateway vs a dedicated
    microservice).
  - The "all routes protected by default; opt out via
    `@Public()`" decision.
  - Token verification by downstream microservices (if not in
    scope today, link the future task that handles it).
- [ ] `docs/adr/NNN-password-hashing-with-argon2.md` (optional —
  fold into the JWT ADR if short).

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds — including the new auth specs.
- [ ] `yarn test:e2e` succeeds — including the auth flow.
- [ ] An unauthenticated `curl http://localhost:3000/api/order`
  returns 401 (smoke test from a running stack — record raw
  output in carryover).
- [ ] A login + authenticated order create returns 201 (smoke).
- [ ] `package.json` lists `@nestjs/jwt`, `@nestjs/passport`,
  `passport`, `passport-jwt`, `argon2` as runtime deps.
- [ ] The new ADR exists with Status: Accepted and a 3-digit
  number.
- [ ] `apps/api-gateway/src/modules/auth/` contains the four
  layers; `libs/auth/` exports the strategy/guards/decorators.

## Carryover

Write `_carryover-06.md` with:
- Files created (paths + roles).
- Migration filename (timestamp + class).
- Seed users + roles created.
- Whether public registration is enabled or deferred (and the
  reason).
- Whether `argon2` was used or `bcrypt` (if a maintainer's
  preference overrode the default).
- Verification results — including raw smoke-test output.
- ADR numbers assigned.
- Suggested adjustments to task-07 (notification) — particularly
  whether `UserLoggedIn` events should be consumed by
  notification.
- Open follow-ups (e.g. password reset flow, email
  verification, rate-limiting on `/auth/login`) flagged for
  post-migration work.
