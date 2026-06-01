---
epic: epic-01
task_number: 5
title: Add the `customer` table, the `Customer` aggregate, and customer-side register/login/me endpoints
depends_on: [task-01, task-02, task-03, task-04]
doc_deliverable_primary: docs/implementation/01-baseline-identity-staffuser-customer-rbac/04-customer-register-and-login.md
doc_deliverable_secondary: docs/implementation/01-baseline-identity-staffuser-customer-rbac/01-staffuser-customer-split.md
---

# Task 05 — `customer` table + `Customer` aggregate + customer-side register/login/me endpoints

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Introduce the buyer-side identity baseline. Add a `customer` table (gateway-side), a `Customer` domain aggregate, and three new HTTP endpoints under `/api/auth/customer/*` for register, login, and "me". The table shape must already accommodate the Q7 guest path (`password_hash` nullable, `email_verified_at` nullable, `status='guest'` legal) and the Q6 tombstone path (every PII column nullable) — even though neither flow is implemented in this epic.

Reuse the existing `JwtTokenAdapter`, `Argon2PasswordAdapter`, and `IJwtAccessPayload` shape — the customer JWT carries the same envelope as the staff JWT, but with `roles: []` and `permissions: []`. The customer is **not** an RBAC actor.

## Entry state assumed

Task-04 carryover present:

- `PermissionsGuard` global; `@RequiresPermission()` exists; `request.user.permissions` populated on staff JWTs.
- `IJwtAccessPayload` carries `permissions: string[]`.
- `StaffUser` is the staff aggregate; `staff_user` table exists; `staff_user_roles` join exists.
- `RoleEnum` has no `CUSTOMER` value (removed in task-02).
- The customer-login describe block in `test/auth.e2e-spec.ts` is commented out with a `TODO(task-05)` marker (per task-02).
- Doc `01-staffuser-customer-split.md` exists with a `<!-- customer-half-anchor -->` marker awaiting append.

## Scope

**In:**

- New `customer` table per the epic's "In-Scope Entities" specification.
- New `Customer` domain aggregate (separate from `StaffUser`).
- New TypeORM entity, mapper, repository, repository port + DI token.
- New use cases: `RegisterCustomerUseCase`, `LoginCustomerUseCase`, `GetCurrentCustomerUseCase`.
- New `customer-auth.controller.ts` mounted at `/api/auth/customer`.
- An `IAuthUserValidator` that distinguishes staff vs. customer subjects so `JwtStrategy` can route a customer JWT to the customer repo. Concrete approach: extend the JWT payload with `subjectKind: 'staff' | 'customer'` (default `'staff'` for back-compat on existing tokens), or — preferred — extend `ValidateStaffUserUseCase` to fall back to the customer repo when the staff lookup misses. Pick the second approach — it does not change the payload shape and keeps the strategy single-validator. Rename the file to `validate-jwt-subject.use-case.ts` to reflect the broader responsibility.
- New `RegisterCustomerCommand`, `LoginCustomerCommand`, `CurrentCustomerResponseDto`, and request DTOs (`RegisterCustomerRequestDto`, `LoginCustomerRequestDto`) under the existing `application/dto/` and `presentation/dto/` folders.
- A new migration `<ts>-CreateCustomerTable.ts`.
- Re-enable the customer-login describe block in `test/auth.e2e-spec.ts` (or split into `test/auth-customer.e2e-spec.ts` as the epic prefers; **author it as a new file** per epic §Test Strategy).
- Append the **customer half** to `docs/implementation/.../01-staffuser-customer-split.md` (replace the `<!-- customer-half-anchor -->` marker).
- Write `docs/implementation/.../04-customer-register-and-login.md` from scratch.

**Out:**

- Customer ordering, addresses, payments — owned by epic-05.
- Email verification flow (`email_verified_at` is just a column; the flow comes later).
- Cart / persistent shopping state — owned by epic-05.
- Guest checkout flow — the column shape supports `status='guest'`, but no HTTP path produces guest rows in this epic.
- ConsentRecord and the tombstone-erase flow — owned by epic-13.

## Persistence

`customer` table (column list per the epic):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `CHAR(36)` PK | UUIDv4 |
| `email` | `VARCHAR(255)` NOT NULL UNIQUE | lowercased on construction; UNIQUE index |
| `phone` | `VARCHAR(32)` NULL | nullable for tombstone |
| `first_name` | `VARCHAR(128)` NULL | nullable for tombstone |
| `last_name` | `VARCHAR(128)` NULL | nullable for tombstone |
| `password_hash` | `VARCHAR(255)` NULL | nullable for guest/social — Q7 |
| `status` | `ENUM('active','suspended','guest','deleted')` NOT NULL DEFAULT 'active' | row-level lifecycle |
| `email_verified_at` | `TIMESTAMP` NULL | per epic |
| `refresh_token_hash` | `VARCHAR(255)` NULL | same shape as `staff_user`; reuses `JwtTokenAdapter` |
| `created_at` | `TIMESTAMP` | |
| `updated_at` | `TIMESTAMP` | |

UNIQUE constraint on lowercased `email`. No `version` column (last-writer-wins per epic). No `deleted_at` — soft-delete is communicated via `status='deleted'` (matches the epic's Q6 tombstone shape, which preserves `id` and flips `status` to `deleted` while nulling PII).

## Files to add

- `apps/api-gateway/src/modules/auth/domain/customer.model.ts` — `Customer extends AggregateRoot<string>`. Constructor validates: email regex; `status` ∈ `{active, suspended, guest, deleted}`; `passwordHash` may be null **only** if `status` is `'guest'` or `'deleted'`. Lowercase email on construction. Methods: `static register(...)`, `static rehydrate(...)`, `validatePassword(candidate, hasher)` (returns false if `passwordHash` is null), `suspend()`, `reactivate()`, `markEmailVerified(at: Date)`, `rotateRefreshTokenHash(hash | null)`, `recordLoggedIn()` (emits `CustomerLoggedInEvent`).
- `apps/api-gateway/src/modules/auth/domain/spec/customer.model.spec.ts` — invariants per epic §Test Strategy.
- `apps/api-gateway/src/modules/auth/domain/events/customer-registered.event.ts`, `customer-logged-in.event.ts`.
- `apps/api-gateway/src/modules/auth/application/ports/customer.repository.port.ts` — `ICustomerRepositoryPort` with `findByEmail`, `findById`, `save`. Export `const CUSTOMER_REPOSITORY = Symbol('CUSTOMER_REPOSITORY')`.
- `apps/api-gateway/src/modules/auth/application/use-cases/register-customer.use-case.ts` — accepts `{ email, password, firstName?, lastName? }`, hashes password, inserts `status='active'`, `email_verified_at: null`, returns `Customer`.
- `apps/api-gateway/src/modules/auth/application/use-cases/login-customer.use-case.ts` — verifies password, issues an access JWT with `roles: []`, `permissions: []`, and a refresh JWT; rotates `refreshTokenHash`; emits `CustomerLoggedInEvent`; logs `CustomerLoggedIn` via Pino.
- `apps/api-gateway/src/modules/auth/application/use-cases/get-current-customer.use-case.ts` — input `id`, returns `Customer` projection.
- `apps/api-gateway/src/modules/auth/application/use-cases/spec/register-customer.use-case.spec.ts`, `login-customer.use-case.spec.ts`, `get-current-customer.use-case.spec.ts`.
- `apps/api-gateway/src/modules/auth/application/dto/register-customer.command.ts`, `login-customer.command.ts`.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/customer.entity.ts` — TypeORM entity matching the table above.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/customer.mapper.ts`.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/customer-typeorm.repository.ts` — implements `ICustomerRepositoryPort`.
- `apps/api-gateway/src/modules/auth/presentation/customer-auth.controller.ts` — `@Controller('auth/customer')`, mounts `POST /register`, `POST /login`, `GET /me`. `@Public()` on register + login; `@CurrentUser()` on `/me`.
- `apps/api-gateway/src/modules/auth/presentation/dto/register-customer.request.dto.ts`, `login-customer.request.dto.ts`, `current-customer.response.dto.ts`.
- `migrations/<ts>-CreateCustomerTable.ts` — generated via `yarn migration:create migrations/CreateCustomerTable`; `up` creates the table per the schema above; `down` drops it.
- `test/auth-customer.e2e-spec.ts` — register → login → `GET /api/auth/customer/me` round-trip; assert the decoded customer access JWT has `permissions: []` and `roles: []`.

## Files to modify

- `apps/api-gateway/src/modules/auth/application/use-cases/validate-staff-user.use-case.ts` → **rename to** `validate-jwt-subject.use-case.ts`. Class renamed to `ValidateJwtSubjectUseCase`. Logic: try `STAFF_USER_REPOSITORY.findById(payload.sub)` first; on miss, try `CUSTOMER_REPOSITORY.findById(payload.sub)`; on miss, throw `UnauthorizedException`. Inject both repos. Continue to implement `IAuthUserValidator`. The returned `ICurrentUser.permissions` comes straight from `payload.permissions ?? []` — same as today.
- `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts`:
  - Register `CustomerEntity` in `TypeOrmModule.forFeature([...])`.
  - Add `CustomerTypeormRepository` and `{ provide: CUSTOMER_REPOSITORY, useExisting: CustomerTypeormRepository }`.
  - Add the three new use cases to providers.
  - Add `CustomerAuthController` to `controllers`.
  - Update the `AUTH_USER_VALIDATOR` binding to use `ValidateJwtSubjectUseCase`.
- `apps/api-gateway/src/app/app.module.ts` — extend `DatabaseModule.forRoot([StaffUserEntity, RoleEntity, PermissionEntity])` to include `CustomerEntity`.
- `apps/api-gateway/src/modules/auth/index.ts` — re-export `CustomerEntity`.
- `apps/api-gateway/src/modules/auth/presentation/auth.controller.ts` — add a **deprecation alias** for the staff side: keep `POST /api/auth/login` working (per the epic, "Old route kept as deprecated alias for one release") but also mount it under `/api/auth/staff/login` per the epic's table. Simplest implementation: split the controller — `AuthController` keeps `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me` for back-compat; add a small `StaffAuthController` at `/auth/staff` with handlers that delegate to the same `LoginUseCase`. Or use a controller-array on `@Controller(['auth', 'auth/staff'])` — Nest supports multi-prefix, this is the lighter solution. Choose the multi-prefix path for `LoginController` only (refresh/logout/me stay at `/auth/*`).
- `test/auth.e2e-spec.ts` — re-enable the customer login block (or migrate it into the new `test/auth-customer.e2e-spec.ts` file and remove the placeholder). Update the customer fixture to authenticate via `POST /api/auth/customer/login`, not the staff route.
- `scripts/test-db-seed.ts` — **do not** seed a Customer in this task; task-09 owns that. (The e2e test `test/auth-customer.e2e-spec.ts` should register its fixture customer through the HTTP path, asserting the flow end-to-end, then log in.)

## Files to delete

None (the `validate-staff-user.use-case.ts` rename to `validate-jwt-subject.use-case.ts` is a rename, not delete-then-add).

## Tests

- Unit (new): `customer.model.spec.ts`, `register-customer.use-case.spec.ts`, `login-customer.use-case.spec.ts`, `get-current-customer.use-case.spec.ts`. Updated: the renamed `validate-jwt-subject.use-case.spec.ts` with two-branch coverage (staff hit; customer hit on staff miss; throws on both miss).
- E2E (new): `test/auth-customer.e2e-spec.ts` — register a customer over HTTP, login, hit `/api/auth/customer/me`, assert the decoded JWT carries `permissions: []` and `roles: []`. Also assert that the same JWT is **rejected** by `/api/auth/admin/ping` (403 — the customer doesn't carry `audit:read`).
- E2E (existing): `test/auth.e2e-spec.ts` continues to pass for the staff flow.

## Doc deliverables

### Primary: `04-customer-register-and-login.md` (new)

Target ~120 lines. Sections:

1. **Endpoint surface.** Table mirroring the epic's API Surface table — three customer endpoints + the migrated staff aliases.
2. **Payload symmetry.** Customer access JWTs reuse `IJwtAccessPayload` with `roles: []` and `permissions: []`. Rationale: a single validator (`ValidateJwtSubjectUseCase`) handles both subject kinds; downstream code never has to special-case "is this a staff or customer JWT" — it just reads `request.user`.
3. **Registration semantics.** A `Customer` row is created in `status='active'` with `email_verified_at: null`. No email verification flow yet (deferred). Password hashed with the same `Argon2PasswordAdapter` as staff.
4. **Forward-compatible columns.** Why every PII column is nullable (Q6 tombstone). Why `status='guest'` is legal even though no flow produces a guest row yet (Q7 — every order, including guest orders, will produce a Customer row in epic-05).
5. **Permission to gate customer reads.** Customer endpoints under `/api/auth/customer/*` are either `@Public()` (register, login) or `@CurrentUser()`-only (me). They do not use `@RequiresPermission()` because the customer JWT carries no permissions.

### Secondary: append to `01-staffuser-customer-split.md`

Replace the `<!-- customer-half-anchor -->` marker with the **customer half**. Target ~80 lines for this half:

1. **Why a separate `customer` table.** Same audit-discipline argument as the staff half: a buyer is a different ontological thing from a staff member; conflating them in one table was the proximate cause of `roles: ['admin','customer']` rows that broke the RBAC mental model.
2. **Q7 — every order creates a Customer.** Forward reference to epic-05; the table shape (nullable `password_hash`, `status='guest'` legal) accepts those rows from day one.
3. **Q6 — tombstone friendliness.** Every PII column nullable. Forward reference to epic-13; this task does not implement the erase use case, but the schema must not block it.
4. **Cross-reference to `04-customer-register-and-login.md`** for the endpoint surface.

## Carryover produced

- `Customer` aggregate, `customer` table, `CUSTOMER_REPOSITORY` binding, three new use cases, `CustomerAuthController` at `/api/auth/customer/*`.
- `ValidateJwtSubjectUseCase` (renamed from `ValidateStaffUserUseCase`) — single validator handling both subject kinds.
- Staff login is reachable at both `/api/auth/login` (deprecated alias) and `/api/auth/staff/login` (new canonical path).
- E2E `test/auth-customer.e2e-spec.ts` exists and is green.
- Docs `04-…md` (new) and `01-…md` (customer half appended) complete.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; all new + renamed specs are green.
- [ ] `yarn test:e2e` passes; `test/auth-customer.e2e-spec.ts` round-trip works; the customer JWT is rejected by `/api/auth/admin/ping`.
- [ ] `yarn migration:run` applies cleanly; `customer` table present.
- [ ] `mysql> DESCRIBE customer;` shows the column list above with the correct nullability.
- [ ] `POST /api/auth/login` still returns 200 (back-compat alias); `POST /api/auth/staff/login` also returns 200 (new canonical).
- [ ] Doc `04-customer-register-and-login.md` exists; doc `01-staffuser-customer-split.md` no longer contains the customer anchor marker.
- [ ] No file outside `tmp/` references `tmp/`.
