---
epic: epic-01
task_number: 6
title: Add the IAM admin controller — `/api/iam/roles` and `/api/iam/staff/:id/roles` endpoints
depends_on: [task-01, task-02, task-03, task-04, task-05]
doc_deliverable: docs/implementation/01-baseline-identity-staffuser-customer-rbac/05-iam-admin-endpoints.md
---

# Task 06 — IAM admin controller (`/api/iam/roles`, `/api/iam/staff/:id/roles`)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Expose admin-only endpoints to manage roles (list / create / patch) and to assign or revoke roles on a StaffUser. These are the runtime knobs that make the relational RBAC schema useful — without them, the only way to change a role's permission set or a staff member's role list is by editing seed scripts and re-running migrations.

All endpoints sit behind `@RequiresPermission()` gates from task-04. Mutations that touch the relational schema are wrapped in a single transaction so partial writes don't leave the join tables inconsistent.

## Entry state assumed

Task-05 carryover present:

- `Role`, `Permission`, `StaffUser` aggregates + entities + repositories exist; permission inflation is in place; `PermissionsGuard` is global.
- `RoleEnum` is the typed registry of the four canonical names (admin / catalog-manager / warehouse-staff / order-support).
- The admin StaffUser (`admin@example.com`) is seeded and bound to the `admin` role — used as the test fixture.

## Scope

**In:**

- New `iam` module under `apps/api-gateway/src/modules/iam/` following the standard `domain` / `application` / `infrastructure` / `presentation` layout. The `domain` layer is intentionally thin — `iam` is mostly orchestration over the auth module's `Role`, `Permission`, and `StaffUser` aggregates. Treat the IAM module as a presentation-and-orchestration shell; the aggregates live in `auth`.
- Endpoints per the epic's API Surface table:

  | Method | Path | Permission |
  | --- | --- | --- |
  | `GET` | `/api/iam/roles` | `iam:role-edit` |
  | `POST` | `/api/iam/roles` | `iam:role-edit` |
  | `PATCH` | `/api/iam/roles/:id` | `iam:role-edit` |
  | `POST` | `/api/iam/staff/:id/roles` | `iam:assign` |
  | `DELETE` | `/api/iam/staff/:id/roles/:roleName` | `iam:assign` |

- A new application port `IIamTransactionPort` (or reuse an existing transaction port if one already exists under `libs/database/` — check before adding) so each mutation runs in a single SQL transaction.
- Use cases: `ListRolesUseCase`, `CreateRoleUseCase`, `UpdateRoleUseCase`, `AssignStaffRoleUseCase`, `RevokeStaffRoleUseCase`.
- Cross-module DI: re-export `ROLE_REPOSITORY`, `PERMISSION_REPOSITORY`, `STAFF_USER_REPOSITORY` from the auth module (or import from the auth module's barrel) so the iam module's use cases can inject them without re-registering the repository adapters.

**Out:**

- Renaming a role's `name` (epic: "rename forbidden once seeded"). `UpdateRoleUseCase` accepts `description` and `permissionCodes` only — name is read-only.
- Permission CRUD — the permission code registry is the source of truth (`libs/contracts/auth/permission.enum.ts`); operators don't add codes through an API. (A code added in code lands in the DB on the next seed run; a stale row is harmless.)
- Audit-log persistence — these mutations call the `AUDIT_LOG_PUBLISHER` port skeleton from task-07 (no-op publisher in this epic; real publisher in epic-11). The task-06 doc cross-references task-07's port; the call sites are added in task-07, not here. **Important sequencing**: task-06 lands first; task-07 introduces the port and **then** wires the call sites into the IAM use cases this task adds.

## Endpoint contracts (concrete)

### `GET /api/iam/roles`

Response: `Role[]` projected as `{ id, name, description, permissionCodes: string[] }`. Sorted by `name` ASC.

### `POST /api/iam/roles`

Request body (`CreateRoleRequestDto`): `{ name: string, description?: string, permissionCodes: string[] }`.

Validation:

- `name` matches `^[a-z][a-z0-9-]*$`, length 1..64, must not duplicate an existing role's `name` → 409.
- Every entry in `permissionCodes` must exist in the `permission` table (look up via `IPermissionRepositoryPort.findByCodes`) → 400 with the list of unknown codes if any are missing.

Response: `Role` projection (same shape as `GET`), 201.

### `PATCH /api/iam/roles/:id`

Request body (`UpdateRoleRequestDto`): `{ description?: string, permissionCodes?: string[] }`. Either field may be omitted; if both are omitted, return 400 `"No-op patch"`.

If `permissionCodes` is present, **replace** the role's permission set (not merge). Unknown codes → 400. Wrap the delete-old + insert-new in a single transaction so observers can't see an empty `role_permissions` row set mid-edit.

Response: updated `Role` projection.

### `POST /api/iam/staff/:id/roles`

Request body (`AssignStaffRoleRequestDto`): `{ roleNames: string[] }`.

Behaviour:

- Look up `StaffUser` by id; 404 if missing or `status='suspended'`.
- Look up roles by name via `IRoleRepositoryPort.findAllByNames`; 400 if any name is unknown.
- **Idempotent**: re-assigning a role the StaffUser already has is a no-op. The aggregate's `assignRole` enforces this; the use case just delegates.
- Single transaction; emit `StaffUserRolesAssigned` domain event (new) with the diff (just the *added* names).

Response: updated `StaffUser` projection `{ id, email, roleNames: string[] }`.

### `DELETE /api/iam/staff/:id/roles/:roleName`

Path params; no body.

Behaviour:

- Look up `StaffUser`; 404 if missing.
- If the StaffUser doesn't currently have `:roleName`, 404 `"Role not bound"` (don't silently 204 — the caller probably has a stale UI).
- The aggregate's `revokeRole(role)` refuses to remove the last role; surface that as 409 `"Cannot revoke the last remaining role"`.
- Emit `StaffUserRoleRevoked` event.

Response: 204.

## Files to add

- `apps/api-gateway/src/modules/iam/iam.module.ts`.
- `apps/api-gateway/src/modules/iam/index.ts` — barrel.
- `apps/api-gateway/src/modules/iam/application/use-cases/list-roles.use-case.ts`, `create-role.use-case.ts`, `update-role.use-case.ts`, `assign-staff-role.use-case.ts`, `revoke-staff-role.use-case.ts`.
- `apps/api-gateway/src/modules/iam/application/use-cases/spec/create-role.use-case.spec.ts`, `assign-staff-role.use-case.spec.ts` — at minimum, per epic §Test Strategy. Add the others (`update-role`, `list-roles`, `revoke-staff-role`) too — they're cheap and round out coverage.
- `apps/api-gateway/src/modules/iam/application/dto/create-role.command.ts`, `update-role.command.ts`, `assign-staff-role.command.ts`, `revoke-staff-role.command.ts`.
- `apps/api-gateway/src/modules/iam/presentation/iam.controller.ts` — `@Controller('iam')`, with the five handlers above. Decorators: `@ApiTags('IAM')`, `@ApiBearerAuth()`, `@RequiresPermission(...)` per the table.
- `apps/api-gateway/src/modules/iam/presentation/dto/role.response.dto.ts`, `staff-roles.response.dto.ts`, request DTOs mirroring the command shapes with class-validator decorators.
- `apps/api-gateway/src/modules/auth/domain/events/staff-user-roles-assigned.event.ts`, `staff-user-role-revoked.event.ts`.
- `test/iam.e2e-spec.ts` per epic §Test Strategy: admin logs in, creates a role bound to one permission, assigns it to a staff user, that staff user logs in and accesses a gated endpoint (use `/api/auth/admin/ping` as the gated probe — re-bind it temporarily, or add a second smoke endpoint). Then admin revokes the role and re-verifies the same probe returns 403.

## Files to modify

- `apps/api-gateway/src/app/app.module.ts` — import `IamModule`. The relational entities (`RoleEntity`, `PermissionEntity`, `StaffUserEntity`) are already registered with `DatabaseModule.forRoot([...])`, so nothing else changes at the global level.
- `apps/api-gateway/src/modules/auth/index.ts` — re-export `ROLE_REPOSITORY`, `PERMISSION_REPOSITORY`, `STAFF_USER_REPOSITORY` for cross-module injection (`iam` injects these). The aggregates themselves are also re-exported for the use cases that need to construct or rehydrate them (e.g., `RoleAggregate.create` for `CreateRoleUseCase`).
- `apps/api-gateway/src/modules/auth/application/ports/role.repository.port.ts` (added in task-01) — extend `IRoleRepositoryPort` with `findById(id): Promise<RoleAggregate | null>` and `delete(id): Promise<void>` (the latter for hypothetical role deletion, but **do not** add a delete endpoint in this task; epic-12 may revisit). Skip the `delete` extension if it adds friction without immediate use; only `findById` is required by `UpdateRoleUseCase`.
- `apps/api-gateway/src/modules/auth/application/ports/staff-user.repository.port.ts` — confirm `findById` returns a `StaffUser` with `roles` (and roles' permissions) eagerly loaded; if not, fix the adapter's `relations` clause in task-02's `StaffUserTypeormRepository`.

## Files to delete

None.

## Transaction handling

Check `libs/database/` for an existing transaction-port pattern (look for `ITransactionPort` or `withTransaction`). If one exists, inject it into `UpdateRoleUseCase` (replace-permission-set is the only multi-write operation that genuinely needs atomicity). If not, use TypeORM's `EntityManager.transaction(async (mgr) => { ... })` *inside the adapter* — never in the use case (lib-contracts/application-port boundaries forbid `typeorm` imports in `application/`, per `spec/architecture-lint.spec.ts`). Concretely:

- Add a `replacePermissions(role: RoleAggregate, codes: string[]): Promise<RoleAggregate>` method to `IRoleRepositoryPort`.
- Implement it in `RoleTypeormRepository` using `manager.transaction(async (txMgr) => { ... clear role_permissions row set; insert new bindings ... })`.
- The use case just calls `roleRepo.replacePermissions(role, command.permissionCodes)`.

Same approach for `AssignStaffRoleUseCase` if it needs to handle the multi-role-add as one transaction (which it should, for idempotency under concurrent calls).

## Tests

- Unit per file list above. The `create-role.use-case.spec.ts` must cover: duplicate name → 409 (`ConflictException`), unknown permission code → 400 (`BadRequestException`). The `assign-staff-role.use-case.spec.ts` must cover: happy path, duplicate-assignment-is-idempotent, non-existent-role-rejected.
- E2E `test/iam.e2e-spec.ts`: admin login → POST `/api/iam/roles` (new role with `iam:role-edit` only) → assign to a fixture staff user → that user logs in → asserts they can hit the gated probe (use `audit:read`-gated `/auth/admin/ping` indirectly — or, simpler, expose a temporary `/api/iam/probe` that uses `@RequiresPermission('iam:role-edit')` for test scaffolding; remove before commit). Cleanest path: PATCH the new role to also include `audit:read`, then verify `/auth/admin/ping` works; revoke, verify 403.

## Doc deliverable

Write `docs/implementation/01-baseline-identity-staffuser-customer-rbac/05-iam-admin-endpoints.md`. Target ~150 lines. Sections:

1. **Endpoint table.** Copy of the epic's API Surface IAM rows + the permission code each requires.
2. **Request/response shapes.** Compact OpenAPI-style snippets for each endpoint.
3. **Error model.** Map of each error path to its HTTP code (409 duplicate, 400 unknown code, 404 missing staff, 404 role-not-bound, 409 cannot-revoke-last). Why the choices: 409 for "your request would create an invalid state but the resource exists"; 400 for "the input is malformed or references nothing"; 404 for "the resource isn't there".
4. **Concurrency.** All multi-row mutations are wrapped in a transaction at the adapter layer. Last-writer-wins; no `version` column, no optimistic-concurrency check — the epic explicitly defers concurrency to epic-12.
5. **Idempotency on assign.** Re-assigning the same role is a no-op. Important for retried POSTs (idempotency-key support comes in epic-12; until then, idempotent semantics at the domain level cover the common case).
6. **Audit-log call sites — forward reference.** This task adds the use cases; task-07 wraps each mutation in `AUDIT_LOG_PUBLISHER.publish(...)` calls. Until task-07 ships, the use cases log via Pino with structured fields (`{ actorId, action, target }`) so the call sites are observable.
7. **Why a separate `iam` module.** Auth owns the aggregates; iam owns the admin-side orchestration. Keeping them separate prevents auth from depending on the IAM admin DTOs, which would force every test of the auth domain to import IAM scaffolding.

## Carryover produced

- New `iam` module + controller mounted at `/api/iam`.
- Five new use cases + their specs.
- Two new domain events (`StaffUserRolesAssigned`, `StaffUserRoleRevoked`) — used by task-07 to flow the audit-log entries through the publisher.
- `IRoleRepositoryPort` extended with `findById` (and `replacePermissions` if not already present).
- E2E `test/iam.e2e-spec.ts` green.
- Doc `05-iam-admin-endpoints.md`.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the five IAM use-case spec files are green.
- [ ] `yarn test:e2e` passes; `test/iam.e2e-spec.ts` round-trip works.
- [ ] Admin can create a role, assign it to a staff user, and that staff user's next login gains the permission; admin can revoke the role and the next login loses it.
- [ ] Unknown permission codes in a `POST /api/iam/roles` request return 400 with the list of unknown codes; duplicate names return 409.
- [ ] Revoking the last role on a StaffUser returns 409 (not 400) with `"Cannot revoke the last remaining role"`.
- [ ] Doc `05-iam-admin-endpoints.md` exists.
- [ ] No file outside `tmp/` references `tmp/`.
