---
id: epic-01
title: Baseline identity — split StaffUser from Customer, replace simple-array roles with relational RBAC
source_stages: [baseline, walking-skeleton]
depends_on: []
microservices: [api-gateway]
task_subfolder: tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/
docs_subfolder: docs/implementation/01-baseline-identity-staffuser-customer-rbac/
---

# Epic 01 — Baseline identity — split StaffUser from Customer, replace simple-array roles with relational RBAC

## Goal

Establish the identity baseline that every other epic depends on. Split the conflated `user` table (which today doubles as StaffUser and Customer via a `simple-array` `roles` column) into two distinct tables, `staff_user` and `customer`, and replace the `simple-array` roles representation with a relational `Role` + `Permission` model (with `staff_user_roles` and `role_permissions` join tables). Wire a `PermissionsGuard` alongside the existing `RolesGuard` so role-bundled atomic permission codes (e.g. `catalog:write`, `inventory:adjust`, `order:cancel`) become the authoritative gating mechanism. Backfill `auth.http` in the Kulala folder so the existing auth endpoints have first-class HTTP documentation before any new endpoints land. After this epic, every cluster epic has unambiguous answers to "who is the buyer?" and "who is the staff actor?".

## In-Scope Entities and Operations

- **StaffUser** (replaces the current `user` table): `id`, `email` (unique, lowercased), `passwordHash` (argon2id), `status` (active | suspended), `lastLoginAt`, `createdAt`, `updatedAt`, `deletedAt` nullable.
- **Customer** (new): `id`, `email` (unique, lowercased), `phone`, `firstName`, `lastName`, `passwordHash` (nullable for guest/social), `status` (active | suspended | guest | deleted), `emailVerifiedAt`, `createdAt`, `updatedAt`.
- **Role** (new entity, replaces TypeScript enum-as-source-of-truth): `id`, `name` (unique, kebab-case), `description`.
- **Permission** (new entity): `id`, `code` (unique, colon-separated `<aggregate>:<verb>`), `description`.
- **staff_user_roles** join table.
- **role_permissions** join table.
- Operations the report names that this epic implements: **Authenticate Staff** (login → JWT, emits log line + audit row), **Assign Role** (admin only; mutates `staff_user_roles`), **Create/Modify Role** (admin only; mutates `role_permissions`), **Authorize Action** (every protected endpoint resolves via `PermissionsGuard`).
- Operations the report names that are RE-confirmed (already partially present, restated under the new shape): **Register Customer** (Customer self-service signup — Stage 1; refined further in epic-05/13), **Update Profile** (Customer self-service; non-PII fields only at this stage).
- **Seed data:** one admin StaffUser (`admin@example.com`), one warehouse-staff StaffUser, one order-support StaffUser, one catalog-manager StaffUser; one Customer (`customer@example.com`); the four canonical Roles each bound to the permission codes their job implies; the permission code registry seeded from a single source of truth in `libs/contracts/auth/permission.enum.ts`.

## Non-Goals

- **ConsentRecord** and the **Erase Customer (tombstone)** path — owned by `epic-13`.
- **AuditLogEntry persistence** — owned by `epic-11`. This epic logs auth events to Pino with `userId` and `correlationId` as today; it does NOT add the `audit_log_entry` table.
- **MFA / SSO / OIDC federation** — Exclusions Register (owned by `epic-15`).
- **Customer ordering UX, addresses, payments** — owned by `epic-05`.
- **Scoped or ABAC roles** — Exclusions Register (owned by `epic-15`).
- **The retail-microservice's `customer` table** — that table will be dropped as part of `epic-05` when retail is rebuilt; this epic does not touch it. Retail's `customer` table is dead-on-arrival once epic-05 lands.

## Architectural Decisions Honored

- **Per Open Question Q7**, every order produces a Customer row, including guests, distinguished by `status='guest'`. The Customer table therefore must accommodate guest-shape rows from day one (`passwordHash` nullable, `emailVerifiedAt` nullable). This epic stops short of implementing guest checkout — but the table shape must already permit it.
- **Per Open Question Q6**, the right-to-be-forgotten implementation is tombstone (null PII, preserve `id`, status flips to `deleted`). This epic does not implement the erase flow but the Customer table must allow every PII column to be nullable except `id` and `status` so the future tombstone path is non-destructive at the schema level.
- **Per Open Question Q1 (forward-looking)**, the Customer entity must support being referenced by a future persistent `Cart` (and by `Reservation` transitively). Customer `id` is a stable, never-recycled identifier.
- **Per the report's Cross-Cutting "Soft delete vs hard delete"** section: StaffUser is a soft-delete entity (referenced by audit log rows that survive deactivation — `status='suspended'`). The Customer row itself is also soft-delete; PII columns inside it become hard-deletable on Q6 erase.
- **Per the report's Cross-Cutting "Auditability"** section, every StaffUser action that mutates a Role/Permission/role-binding MUST eventually flow to `AuditLogEntry`. This epic adds a port (`AUDIT_LOG_PUBLISHER`) with a no-op default adapter — the real implementation lands in epic-11 — so that the call sites are correct from the start and only the adapter needs swapping later.
- **ADR-004** (per-module hexagonal): the auth module's existing `domain/application/infrastructure/presentation` layout is preserved; new aggregates (`Role`, `Permission`) and the new `Customer` aggregate slot into the existing module structure.
- **ADR-010** (JWT + RBAC at the gateway): the existing `JwtAuthGuard` + `RolesGuard` global-guard wiring is preserved. A new global `PermissionsGuard` is added downstream of `RolesGuard`. The `@Public()`, `@Roles()`, and new `@RequiresPermission()` decorators co-exist; `@Roles()` remains valid for coarse gating, `@RequiresPermission()` is the precise gate.
- **ADR-017** (architecture lint): the new tables, ports, and adapters must pass `yarn lint`. The existing `spec/architecture-lint.spec.ts` fixture set is extended for the new `customer.entity.ts`, `role.entity.ts`, `permission.entity.ts`.
- **ADR-019** (TypeORM + MySQL): the new entities use `BaseEntity` + `SnakeNamingStrategy`; all DDL goes through a fresh `migrations/<ts>-…ts` file. The existing migrations may be coalesced or simply layered on top — destructive changes to the old `user` table are permitted (no data to preserve).

## Persistence Changes

**Added:**

- `staff_user` table (the existing `user` table is renamed and trimmed — `roles: simple-array` column dropped).
- `customer` table (new; gateway-side; replaces the retail-microservice's `customer` table conceptually, though the retail-side drop is owned by epic-05).
- `role` table (`id`, `name` unique, `description`).
- `permission` table (`id`, `code` unique, `description`).
- `staff_user_roles` join table (composite PK `(staff_user_id, role_id)`).
- `role_permissions` join table (composite PK `(role_id, permission_id)`).
- New seeded permission codes: `catalog:read`, `catalog:write`, `catalog:publish`, `inventory:read`, `inventory:adjust`, `inventory:transfer`, `order:read`, `order:cancel`, `order:refund`, `iam:assign`, `iam:role-edit`, `audit:read`. (Final code list is per-epic-task decision; this list is the seed floor.)

**Removed:**

- `user.roles` simple-array column.
- The TypeScript-enum-as-source-of-truth for roles in `libs/contracts/auth/role.enum.ts` is demoted from authoritative to a typed registry of *seeded* role names; the source of truth becomes the `role` table.

**Indexes & constraints:**

- Unique index on `staff_user.email` (lowercased) and `customer.email` (lowercased).
- Unique index on `role.name` and `permission.code`.
- Foreign-key constraints on both join tables with `ON DELETE CASCADE` (a deleted Role/StaffUser cleans up its links).
- No `version` column on `staff_user` or `customer` at this stage; identity mutations are last-writer-wins per the report's cross-cutting §1.

## Eventing / Messaging

- **No new RabbitMQ exchanges or routing keys** introduced by this epic. Auth events (`UserLoggedIn`, `LoginFailed`, `RefreshTokenRotated`, `LogoutPerformed`) remain Pino-only as today.
- Forward-compatible: an `AUDIT_LOG_PUBLISHER` application-port symbol is introduced in `libs/contracts/auth/audit-log-publisher.port.ts` (interface) with a no-op default adapter bound in the gateway's `auth.module.ts`. The real RMQ adapter that publishes to the event-store microservice ships in `epic-11`.
- Correlation-id propagation continues unchanged via existing `CorrelationMiddleware` + AMQP-headers convention.

## API Surface

**New / modified HTTP endpoints in `api-gateway`:**

| Method | Path | Body / params | Auth | Notes |
|---|---|---|---|---|
| `POST` | `/api/auth/customer/register` | `{ email, password, firstName?, lastName? }` | `@Public()` | New — customer signup; emits `Customer` row in `active` status with `emailVerifiedAt: null`. |
| `POST` | `/api/auth/customer/login` | `{ email, password }` | `@Public()` | New — customer JWT login (mirrors staff `/auth/login` but writes to `customer` table). |
| `GET` | `/api/auth/customer/me` | — | bearer | New — returns the authenticated Customer's profile. |
| `POST` | `/api/auth/staff/login` | `{ email, password }` | `@Public()` | **Renamed** from `/api/auth/login` for clarity. Old route kept as deprecated alias for one release. |
| `GET` | `/api/iam/roles` | — | bearer + `iam:role-edit` | List all roles + their permission codes. |
| `POST` | `/api/iam/roles` | `{ name, description, permissionCodes[] }` | bearer + `iam:role-edit` | Create role. |
| `PATCH` | `/api/iam/roles/:id` | `{ description?, permissionCodes? }` | bearer + `iam:role-edit` | Edit a role (rename forbidden once seeded). |
| `POST` | `/api/iam/staff/:id/roles` | `{ roleNames[] }` | bearer + `iam:assign` | Assign roles to a StaffUser (idempotent). |
| `DELETE` | `/api/iam/staff/:id/roles/:roleName` | — | bearer + `iam:assign` | Revoke a role from a StaffUser. |

**Existing endpoints kept (re-gated):**

- `GET /api/auth/admin/ping` — re-gated behind `@RequiresPermission('audit:read')` as a smoke endpoint.

**Kulala HTTP files** (under `http/`):

- **`http/auth.http`** — NEW; backfills the missing Kulala file for the existing auth endpoints (`/api/auth/staff/login`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/me`, `/api/auth/admin/ping`) PLUS the new customer-side endpoints. Mirrors `http/order.http` conventions (`@baseUrl = {{ENV_BASE_URL}}`, `### / # @name X` blocks, comments cite controller paths).
- **`http/iam.http`** — NEW; covers `/api/iam/roles` (list/create/patch) and `/api/iam/staff/:id/roles` (assign/revoke). Includes a `# Prereqs:` block describing the seeded admin login flow.

## Test Strategy

**Unit tests** (per-domain spec files, siblings of the source):

- `apps/api-gateway/src/modules/auth/domain/spec/staff-user.model.spec.ts` — invariants: email lowercased on construction, status transitions (`active` ↔ `suspended`), no leakage of `passwordHash` via `toJSON`.
- `apps/api-gateway/src/modules/auth/domain/spec/customer.model.spec.ts` — invariants: email lowercased, status transitions (`active` ↔ `suspended` ↔ `guest`), `passwordHash`-nullable invariant for `guest`.
- `apps/api-gateway/src/modules/auth/domain/spec/role.model.spec.ts` — name is kebab-case, permission set is a `Set<string>` (no duplicates).
- `apps/api-gateway/src/modules/auth/domain/spec/permission.model.spec.ts` — code regex `^[a-z][a-z-]*:[a-z][a-z-]*$`.
- `apps/api-gateway/src/modules/auth/application/use-cases/spec/assign-role.use-case.spec.ts` — happy path + duplicate-assignment-is-idempotent + non-existent-role-rejected.
- `apps/api-gateway/src/modules/auth/application/use-cases/spec/create-role.use-case.spec.ts` — duplicate-name-rejected + unknown-permission-code-rejected.
- `libs/auth/spec/permissions.guard.spec.ts` — guard reads JWT permissions claim, intersects with `@RequiresPermission()` metadata, denies on mismatch; the JWT must already carry resolved permission codes (the JWT-issue path inflates roles → permissions on login).

**E2E tests** (through `api-gateway`, written into `test/`):

- `test/auth-customer.e2e-spec.ts` — register → login → `GET /auth/customer/me` round-trip.
- `test/iam.e2e-spec.ts` — admin creates a role, assigns it to a staff user, that staff user gains the gated endpoint; revoking the role removes access.
- `test/auth-rotation.e2e-spec.ts` — preserve and extend the existing refresh-rotation/reuse-detection coverage for the new `staff_user` table.

**Concurrency tests:** N/A at this stage (identity mutations are last-writer-wins).

**Seed data required:**

- `scripts/test-db-seed.ts` extended with: 4 seeded permission codes, 4 seeded roles (admin / warehouse-staff / order-support / catalog-manager), 4 seeded StaffUsers (one per role), 1 seeded Customer (`customer@example.com`).

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/01-baseline-identity-staffuser-customer-rbac/`:

- `01-staffuser-customer-split.md` — what was renamed, what was added, why the split is necessary (Q7 + audit-log discipline).
- `02-role-and-permission-relational-model.md` — schema rationale, seeded permission code list, the JWT inflation path (roles claim → permissions claim).
- `03-permissions-guard-and-decorator.md` — `@RequiresPermission()` ergonomics, interaction with existing `@Roles()`, ordering of guards.
- `04-customer-register-and-login.md` — new customer-side endpoints, password policy, registration-emits-row semantics.
- `05-iam-admin-endpoints.md` — `/iam/roles` and `/iam/staff/:id/roles` shape and permission gating.
- `06-audit-log-publisher-port-skeleton.md` — why the no-op publisher port ships now, what epic-11 will swap in.
- `07-kulala-auth-and-iam-files.md` — what `http/auth.http` and `http/iam.http` contain and how to use them.

**`README.md` updates required:**

- Replace the **System diagram** "API Gateway port: 3000" block with the new route list (add `/auth/staff/*`, `/auth/customer/*`, `/iam/*`).
- Replace the **Authentication → Roles** subsection with a short narrative about the relational `Role` + `Permission` model, including a permission-code-table snippet.
- Add a new **Permissions** subsection under **Authentication** that lists every seeded permission code and which role bundles it.
- Update **Local development** seed users table to match the new seed set (4 staff + 1 customer).

**`CLAUDE.md` updates required:**

- Under **Service Structure → API Gateway → modules/auth**, replace the description of the User aggregate with the StaffUser + Customer + Role + Permission set; update the file-listing snippet under `modules/auth/`.
- Add a new **Authentication conventions (gateway)** bullet noting that `@RequiresPermission(<code>)` is the precise gate and `@Roles(<RoleEnum>)` remains for coarse role bundles.

**Exclusions Register documents owned by this epic:** None — all extension guides live in epic-15.

## Tasks (decomposition hint)

1. **Add the relational Role + Permission tables and seed the permission code registry.** Schema-first; no behavior change at the controller surface yet.
2. **Rename `user` → `staff_user`, drop `roles: simple-array`, add `staff_user_roles` join.** Adapt `UserTypeormRepository` → `StaffUserTypeormRepository` to load roles + permissions via join.
3. **Inflate JWT permissions claim on login.** The access JWT now carries `permissions: string[]` in addition to `roles: string[]`; refresh rotation preserves both.
4. **Introduce `PermissionsGuard` and `@RequiresPermission()` in `libs/auth/`.** Wire it globally via `APP_GUARD` after `RolesGuard`; re-gate `/auth/admin/ping`.
5. **Add the `customer` table + `RegisterCustomerUseCase` + `LoginCustomerUseCase` + `GetCurrentCustomerUseCase`.** Add `customer-auth.controller.ts` (or extend the existing controller under a `/auth/customer/*` subpath).
6. **Add the IAM admin controller** (`/iam/roles`, `/iam/staff/:id/roles`).
7. **Add the `AUDIT_LOG_PUBLISHER` port + no-op default adapter.** All auth use cases call it; the no-op writes a Pino debug line so the call sites are observable.
8. **Author `http/auth.http` and `http/iam.http`.** Backfill existing routes + cover the new ones.
9. **Extend `scripts/test-db-seed.ts`** with the new seed set.
10. **Documentation pass:** write the seven per-task `docs/implementation/.../*.md` files, update `README.md` and `CLAUDE.md`, extend `spec/architecture-lint.spec.ts` fixtures for the new files.

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | Pristine repo + this epic file. | New `role.entity.ts`, `permission.entity.ts`, `role_permissions.entity.ts` under `auth/infrastructure/persistence/`; new migration file under `migrations/`; new permission-code enum/registry under `libs/contracts/auth/`; seed extension; `docs/implementation/01-…/01-…md`. |
| 2 | Task 1 carryover present. | Renamed `staff_user.entity.ts`; new `staff_user_roles.entity.ts`; updated `StaffUserTypeormRepository`; new migration; `docs/implementation/.../02-…md`. |
| 3 | Tasks 1–2 carryover present; auth use cases compile. | Updated `JwtTokenAdapter`/JWT payload contract in `libs/contracts/auth/jwt-payload.dto.ts`; updated login + refresh use cases; updated specs; `docs/implementation/.../03-…md`. |
| 4 | Tasks 1–3 carryover present. | New `libs/auth/permissions.guard.ts`, `libs/auth/requires-permission.decorator.ts`; updated `libs/auth/index.ts` re-exports; updated `app.module.ts` `APP_GUARD` wiring; `docs/implementation/.../03-…md` (continued). |
| 5 | Tasks 1–4 carryover present. | New `customer.entity.ts`, `customer.mapper.ts`, `CustomerTypeormRepository`; new customer use cases + spec files; new presentation DTOs; new customer-auth controller; `docs/implementation/.../04-…md`. |
| 6 | Tasks 1–5 carryover present. | New `iam.controller.ts` + use cases + DTOs; `docs/implementation/.../05-…md`. |
| 7 | Tasks 1–6 carryover present. | New `libs/contracts/auth/audit-log-publisher.port.ts`; default no-op adapter under `apps/api-gateway/src/modules/auth/infrastructure/audit/`; call-site additions in the auth use cases; `docs/implementation/.../06-…md`. |
| 8 | Tasks 1–7 carryover present. | New `http/auth.http`, `http/iam.http`; `docs/implementation/.../07-…md`. |
| 9 | Tasks 1–8 carryover present. | Updated `scripts/test-db-seed.ts`. |
| 10 | All prior tasks complete; code compiles + lints + tests green. | Updated `README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts`. |

## Exit Criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); new files are correctly placed per ADR-017 boundaries.
- [ ] `yarn test:unit` passes; new domain + use-case + guard specs are green.
- [ ] `yarn test:e2e` passes; `test/auth-customer.e2e-spec.ts`, `test/iam.e2e-spec.ts`, and the extended `test/auth-rotation.e2e-spec.ts` are green against fresh test infra + seed.
- [ ] `docker compose up -d mysql redis rabbitmq && yarn migration:run && yarn start:dev:api-gateway` boots the gateway with the new tables present.
- [ ] All requests in `http/auth.http` and `http/iam.http` execute end-to-end against the seeded admin user.
- [ ] `GET /api/auth/admin/ping` is gated behind `audit:read`; a StaffUser lacking the permission gets `403`, the seeded admin gets `200`.
- [ ] The `user.roles` simple-array column is gone from the schema; `\d staff_user` (or the MySQL equivalent) shows no `roles` column.
- [ ] Per-task docs present under `docs/implementation/01-baseline-identity-staffuser-customer-rbac/`.
- [ ] `README.md` Authentication section reflects the relational RBAC model; `CLAUDE.md` modules/auth listing matches the new file set.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
