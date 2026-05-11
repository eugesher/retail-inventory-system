# ADR-010: JWT authentication and RBAC at the API gateway

- **Date**: 2026-05-10
- **Status**: Accepted

---

## Context

Pre-task-06 the codebase had **no authentication and no authorization** at any
layer: `package.json` carried no `@nestjs/jwt` / `@nestjs/passport` /
`passport*` / `argon2` / `bcrypt`, and no `auth/` folder existed under
`apps/api-gateway/src/`. Every HTTP route was reachable by any client. This is
acceptable for the audit baseline that the migration started from; it is not
acceptable for the deliverable.

Task-06 adds end-to-end authentication and role-based authorization. The
decisions in this ADR record the *shape* we picked rather than the
incremental task notes — those live in the `_carryover-06.md` file alongside
the task script and are deleted before merge.

ADR-009 already established the per-module hexagonal layout for the gateway;
auth is the first gateway module with a real `domain/` aggregate, so the ADR
also documents how that aggregate fits.

## Decision

### 1. JWT (HS256) over session cookies and external OAuth

**Chosen.** Stateless JWTs (HS256) for both access and refresh tokens, signed
with two independent secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`).

**Rejected: server-side session cookies.** Sessions force every microservice
to talk to a shared session store (Redis today, but a new SPOF) before
authorizing any request. JWTs let the gateway hand a short-lived bearer token
to downstream microservices, which can validate it offline against the same
public/secret material. This matches our existing "no cross-service shared
state except RabbitMQ payloads" pattern and keeps `libs/contracts/auth/`
framework-free so future services can validate without pulling in
`@nestjs/passport`.

**Rejected: outsourcing to an external OAuth provider (Auth0, Cognito,
Keycloak).** The migration prioritises a zero-external-dependency portfolio
project; pulling in an IdP would dwarf the rest of the work in operational
weight. Documented as future option — if rolled in, the `User` aggregate
becomes a profile cache and the password adapter retires.

### 2. argon2id over bcrypt

**Chosen.** `argon2` (npm) with `argon2id`, OWASP 2024 minimum cost
parameters (`memoryCost: 19_456` KiB, `timeCost: 2`, `parallelism: 1`),
tunable per-environment via `AUTH_ARGON2_MEMORY_COST` / `_TIME_COST` /
`_PARALLELISM`.

argon2id is the OWASP-recommended default for new applications: memory-hard,
GPU-resistant, and the winner of the Password Hashing Competition. `bcrypt`
is still acceptable but caps at 72-byte inputs and is not memory-hard. Since
this is a greenfield auth surface (no legacy hashes to migrate from), there
is no reason to pick the older primitive.

### 3. Refresh-token rotation with reuse detection

**Chosen.** Every successful `/auth/refresh`:

1. Verifies the refresh JWT signature + expiry.
2. argon2-verifies the presented token against the hash persisted on the
   `user` row (`refresh_token_hash`).
3. On match: issues a new access + refresh JWT, stores the new hash, returns
   both. The old refresh token is now invalid (its hash no longer matches).
4. On mismatch: clears the live `refresh_token_hash` (defensive — assume
   compromise) and returns 401. This trips a circuit-breaker against an
   attacker who steals a refresh token: the legitimate user's next refresh
   fails, forcing a fresh login.

The hash (not the raw token) is what's persisted, so a database leak does
not hand attackers replayable refresh tokens. Argon2 verifies in
~5–10 ms per call at our cost parameters — non-trivial but acceptable for a
once-every-15-minutes operation.

**Rejected: stateless refresh.** Without the persisted hash, there is no
revocation channel: a stolen refresh token is valid until its 7-day lifetime
expires.

### 4. The `User` aggregate lives in the gateway

**Chosen.** `apps/api-gateway/src/modules/auth/` owns `User`. The gateway
gains a TypeORM connection (`DatabaseModule.forRoot([UserEntity])`).

**Rejected: dedicated `user-microservice`.** Adds a new RabbitMQ hop on
**every** authenticated request — the JWT strategy's `validate()` callback
would need to RPC out to look up the active user. The latency hit is
unacceptable for hot paths, and the deployment surface grows with no
short-term gain.

**Rejected: `User` lives in `retail-microservice` next to `customer`.** The
`customer` row in retail represents a buyer, not an authenticated principal:
a future "store manager" admin may have no `customer` row and still need to
log in. Coupling the two now would force a refactor later.

### 5. All routes protected by default

**Chosen.** `JwtAuthGuard` and `RolesGuard` are registered as global
`APP_GUARD` providers in `apps/api-gateway/src/app/app.module.ts`. Every
route is bearer-token-required unless the handler or controller carries
`@Public()` from `@retail-inventory-system/auth`.

The opt-out is **explicit on the route**, not on a configuration list:
nobody can accidentally expose a new endpoint by forgetting to add it to a
shared "protected routes" array. The two `@Public()` routes today are
`POST /auth/login` and `POST /auth/refresh`; everything else (including
`/auth/logout`, `/auth/me`, `/order/*`, `/product/*/stock`) requires a
valid access token.

`@Roles(RoleEnum.X, …)` layers role-based authorization on top. Existing
routes are tagged with `@Roles(RoleEnum.CUSTOMER, RoleEnum.ADMIN)`. The
admin role inherits customer access by being seeded with both roles — there
is no role hierarchy in the guard logic.

### 6. Token verification by downstream microservices is deferred

`libs/contracts/auth/` exports the `IJwtAccessPayload` shape so a future
microservice can validate the token offline. Today, downstream microservices
trust the gateway: payloads carry `correlationId` but not yet the JWT.
Threading the bearer or a stripped principal through RabbitMQ payloads is a
**future task** — it costs a `libs/contracts` shape change, a publisher-port
update, and `@MessagePattern`-side verification. Not in scope for task-06.

When that work lands, it slots into ADR-008's wire format without breaking
existing call sites: a new optional `authContext` field on the payload, with
gateway-side population and microservice-side `JwtAuthGuard` (mounted on
the RPC transport). This ADR pre-commits to **HS256 with the
`JWT_ACCESS_SECRET` shared across services** for the cross-service variant
— RS256 is a future option once a proper key-distribution mechanism (HSM,
Vault) is in scope.

### 7. Public registration is deferred

`RegisterUserUseCase` exists and is unit-tested, but is **not** exposed via
HTTP. Seed users (`admin@example.com` / `customer@example.com`) cover every
test scenario today; the live registration flow needs rate limiting, email
verification, and CAPTCHA before it can be safe to expose, none of which is
in scope. Documented as a follow-up in `_carryover-06.md`.

### 8. Smoke endpoint for the admin role guard

`GET /auth/admin/ping` exists solely to give the role guard an admin-only
target so the customer-vs-admin 403 path is exercised in E2E tests. It is
not a production user-management surface; if a real admin API surfaces in a
later task, this stub gets replaced.

## Consequences

- The gateway acquires a TypeORM connection; until task-06, only microservices
  did. Migration-wise this means the gateway's `app.module.ts` now calls
  `DatabaseModule.forRoot([UserEntity])`. The connection is shared with the
  retail/inventory microservices' MySQL database (same `DATABASE_URL`),
  which keeps Docker happy at the cost of cross-service write coupling on
  the `user` table — only the gateway writes to it.
- `libs/auth/` is a Nest-aware library. Domain code (under `apps/*/src/.../domain/`)
  must not depend on it; consumers are gateway controllers / use-cases /
  modules. The DDD-purity rule from CLAUDE.md still holds.
- The Joi config schema in `libs/config` now requires `JWT_ACCESS_SECRET`
  and `JWT_REFRESH_SECRET` (≥ 32 chars each, distinct). A stack started
  without these env vars fails fast at boot.
- The RoleEnum value is `'admin' | 'customer'`. Adding a new role is a
  three-file edit (`libs/contracts/auth/role.enum.ts`, the seed, the route's
  `@Roles(...)` annotation) — small enough that no further indirection is
  warranted today.

## Alternatives considered (summary)

| Decision | Picked | Rejected | Why |
| -------- | ------ | -------- | --- |
| Token type | JWT (HS256) | Server-side sessions; external OAuth | Stateless; no SPOF; portfolio scope. |
| Password hash | argon2id | bcrypt | OWASP recommendation; greenfield. |
| Refresh policy | Rotation w/ reuse detection | Stateless refresh | Revocation; reuse signal. |
| User home | Gateway | New microservice; retail microservice | Latency; concept fit. |
| Default route policy | Protected | Opt-in protection | Fail-closed on new routes. |
| Token verification downstream | Deferred | In scope today | Sequenced after publisher-port introduction (task-08/09). |

## References

- OWASP Password Storage Cheat Sheet (2024 edition) — argon2id parameters.
- OWASP JWT Cheat Sheet — RS256 vs HS256 trade-offs.
- ADR-004 — hexagonal-per-service.
- ADR-008 — RabbitMQ wire format (relevant to the future cross-service auth).
- ADR-009 — gateway port/adapter split (the layout this auth module slots
  into).
