# task-07 — Write auth stack (Phase: auth/) — DRAFT

> **DRAFT — may be revised by task-01.** This is the second
> **clarification group**: the five auth libraries
> (`@nestjs/passport`, `passport`, `passport-jwt`, `@nestjs/jwt`,
> `argon2`) confuse readers because they layer on top of each other
> in non-obvious ways.

## Context

- Migration source of truth: ADR-010 (full — JWT, RBAC, argon2id,
  refresh rotation, gateway-owns-User), `parts/recommendation.md`
  Section 4 (naming conventions), `docs/architecture-migration-plan/tasks/task-06-build-auth-from-scratch.md`
  (the executed task that built the auth module).
- Previous carryover:
  `docs/architecture-migration-ru/tasks/_carryover-06.md`
  (READ FIRST).
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: caching is written, including the
  port-and-adapter pattern via `ICachePort`. Auth is the second
  clarification group and the **only** part of the project with a
  real domain on the gateway side.

## Prerequisites

- [ ] `_carryover-06.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] HEAD SHA is recorded in `_carryover-01.md`.
- [ ] Every clarification-group library in this task is confirmed
      present in `package.json` (task-01's `## Discrepancies`
      section is empty for the auth stack).

## Goal

Write a JWT+RBAC overview + an auth stack overview + five per-library
articles. After reading the stack overview a reader must be able to
answer:

- Why is there both `passport` and `@nestjs/passport`?
- What's the role of `passport-jwt` vs `@nestjs/jwt`?
- Why `argon2id` and not bcrypt?
- Where does `JwtStrategy` plug in, and where does
  `JwtAuthGuard` plug in?

## Article slots to fill

- [ ] `docs/architecture-migration-ru/auth/jwt-and-rbac.md`
- [ ] `docs/architecture-migration-ru/auth/auth-stack-overview.md`
- [ ] `docs/architecture-migration-ru/auth/lib-nestjs-passport.md`
- [ ] `docs/architecture-migration-ru/auth/lib-passport.md`
- [ ] `docs/architecture-migration-ru/auth/lib-passport-jwt.md`
- [ ] `docs/architecture-migration-ru/auth/lib-nestjs-jwt.md`
- [ ] `docs/architecture-migration-ru/auth/lib-argon2.md`

> Approximate guidance:
>
> - **jwt-and-rbac** — ~2500 words. The decisions from ADR-010:
>   HS256 access + refresh, argon2id passwords, refresh rotation
>   with reuse detection, `JwtAuthGuard` + `RolesGuard` as global
>   `APP_GUARD`, `@Public()` opt-out, `@Roles()` layering. The
>   `User` aggregate on the gateway (the only gateway module with
>   a domain), and why it's not in a separate microservice.
> - **auth-stack-overview** — ~2500 words. Diagram of the request
>   flow: `Authorization: Bearer <jwt>` → `passport-jwt` extracts &
>   verifies → `JwtStrategy.validate()` → `AUTH_USER_VALIDATOR`
>   resolves a user → `JwtAuthGuard` populates `req.user` →
>   `@CurrentUser()` injects it. Argon2 verify on `/auth/login`
>   and `/auth/refresh`.
> - **lib-nestjs-passport** — ~700 words. Nest wiring layer over
>   `passport`. `PassportStrategy` base class, `AuthGuard('jwt')`.
>   What it does NOT do: it is not a strategy itself, it is the
>   `Passport` middleware for Nest.
> - **lib-passport** — ~600 words. The original middleware. What it
>   does NOT do: it does not implement any specific authentication
>   method (those are separate strategies).
> - **lib-passport-jwt** — ~700 words. The JWT strategy that
>   `JwtStrategy` extends. JWT extraction (`fromAuthHeaderAsBearerToken`)
>   and verification. What it does NOT do: it does not issue tokens
>   — that's `@nestjs/jwt`.
> - **lib-nestjs-jwt** — ~700 words. The `JwtService` injected by
>   `JwtTokenAdapter` to sign access and refresh JWTs. What it does
>   NOT do: it does not verify request headers — that's
>   `passport-jwt`.
> - **lib-argon2** — ~700 words. `argon2.hash` + `argon2.verify` with
>   the OWASP-2024 defaults from ADR-010. The
>   `AUTH_ARGON2_{MEMORY_COST,TIME_COST,PARALLELISM}` env vars and
>   why argon2id over bcrypt.

## Steps

1. **Read previous carryover.**
2. **Read the source ADRs / tasks.** ADR-010 (full),
   `task-06-build-auth-from-scratch.md` and `_carryover-06.md` from
   the migration-plan tasks folder.
3. **Author the JWT+RBAC article.** The conceptual anchor.
4. **Author the stack overview.** Include the request-flow diagram.
5. **Author each per-library article.** The "What it does NOT do"
   section is mandatory.
6. **Code anchors** (verify exact paths in task-01):
   - `libs/auth/auth.module.ts` (`AuthModule.forRootAsync`).
   - `libs/auth/jwt.strategy.ts` (the `PassportStrategy(Strategy)`
     base, the `validate()` hook).
   - `libs/auth/jwt-auth.guard.ts`, `libs/auth/roles.guard.ts`,
     `libs/auth/public.decorator.ts`, `libs/auth/roles.decorator.ts`,
     `libs/auth/current-user.decorator.ts`,
     `libs/auth/role.enum.ts`,
     `libs/auth/auth-user-validator.port.ts`.
   - `apps/api-gateway/src/modules/auth/infrastructure/argon2/argon2-password.adapter.ts`
     (verify exact path) — the argon2id wrapper.
   - `apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts`
     (verify exact path) — the `JwtService`-using adapter.
   - `apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts`,
     `refresh.use-case.ts`, `validate-user.use-case.ts`.
   - `apps/api-gateway/src/app/app.module.ts` — the global
     `APP_GUARD` registration.
7. **Cross-link** to `[[hexagonal-architecture]]`,
   `[[api-gateway-pattern]]`, `[[shared-libs-philosophy]]`,
   `[[entity-vs-domain-model]]` (the `User` aggregate vs the
   `UserEntity` distinction).

## Verification

- [ ] All seven articles filled, no `заглушка` callouts.
- [ ] Permalinks pinned to the recorded SHA on every excerpt.
- [ ] Every wiki link resolves.
- [ ] Each per-library article has a "Что это НЕ делает" section.
- [ ] No orphans.

## Carryover

Write `_carryover-07.md` per the standard structure.
