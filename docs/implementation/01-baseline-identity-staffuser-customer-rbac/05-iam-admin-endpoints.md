# 05 — IAM admin endpoints

This document records the runtime admin surface over the relational RBAC
schema. Without these endpoints, the only way to
change a role's permission set or a staff user's role list would be by
editing the seed script and re-running migrations. The IAM module sits
on top of the auth module's `Role`, `Permission`, and `StaffUser`
aggregates and does no persistence of its own.

The architectural decision this implements is
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md).
The staff/customer split argument lives in
[`01-staffuser-customer-split.md`](./01-staffuser-customer-split.md);
the role/permission schema in
[`02-role-and-permission-relational-model.md`](./02-role-and-permission-relational-model.md);
the gate decorator in
[`03-permissions-guard-and-decorator.md`](./03-permissions-guard-and-decorator.md).

## 1. Endpoint surface

The gateway gains five admin-gated HTTP routes mounted at `/api/iam`.
Every route requires a bearer access token AND the listed permission
code (the global `PermissionsGuard` enforces both).

| Method | Path                                       | Permission       | Notes                                              |
| ------ | ------------------------------------------ | ---------------- | -------------------------------------------------- |
| GET    | `/api/iam/roles`                           | `iam:role-edit`  | Returns `Role[]` sorted by name ASC.               |
| POST   | `/api/iam/roles`                           | `iam:role-edit`  | 201 on create; 409 on duplicate name.              |
| PATCH  | `/api/iam/roles/:id`                       | `iam:role-edit`  | Description + permission set; name read-only.      |
| POST   | `/api/iam/staff/:id/roles`                 | `iam:assign`     | Idempotent — re-assign is a no-op.                 |
| DELETE | `/api/iam/staff/:id/roles/:roleName`       | `iam:assign`     | 204 on success; refuses last role with 409.        |

Both permission codes were already in the registry
(`libs/contracts/auth/permission.enum.ts`) and seeded into the
`permission` table when the role/permission schema was seeded; the
seeded `admin` role bundles every code in the registry, so the e2e
fixture admin can hit every endpoint here.

A sixth route, `POST /api/iam/staff` (`iam:staff-create`), landed later
and is covered by
[ADR-047](../../adr/047-staff-user-creation-over-http.md); it is not
part of the five described below.

## 2. Request/response shapes

### `GET /api/iam/roles` — 200

Response: `RoleResponseDto[]`, sorted by `name` ASC.

```json
[
  {
    "id": "00000000-0000-4000-c000-000000000001",
    "name": "admin",
    "description": "Full access to every permission code",
    "permissionCodes": ["audit:read", "catalog:read", "catalog:write", "..."]
  }
]
```

### `POST /api/iam/roles` — 201

Request `CreateRoleRequestDto`:

```json
{ "name": "audit-reader", "description": "Read-only auditor", "permissionCodes": ["audit:read"] }
```

Validation:

- `name` matches `^[a-z][a-z0-9-]*$`, length 1..64.
- `permissionCodes` is a unique non-empty array; every entry must exist
  in `permission.code`.

Response: same shape as a single element of `GET /api/iam/roles`.

### `PATCH /api/iam/roles/:id` — 200

Request `UpdateRoleRequestDto`:

```json
{ "description": "Audit log read-only access", "permissionCodes": ["audit:read", "order:read"] }
```

Either field may be omitted. Both omitted → 400 `"No-op patch"`.
`permissionCodes` is a **replace**, not a merge; the old `role_permissions`
rows are cleared and the new ones inserted in a single transaction so
observers can't see an empty join set mid-edit (see §4 below). Name is
read-only — renaming a seeded role is explicitly disallowed.

### `POST /api/iam/staff/:id/roles` — 200

Request `AssignStaffRoleRequestDto`:

```json
{ "roleNames": ["warehouse-staff", "order-support"] }
```

Response:

```json
{
  "id": "00000000-0000-4000-a000-000000000001",
  "email": "operator@example.com",
  "roleNames": ["admin", "order-support", "warehouse-staff"]
}
```

### `DELETE /api/iam/staff/:id/roles/:roleName` — 204

No request body. No response body.

## 3. Error model

| HTTP | Path                                                | Trigger                                                                           |
| ---- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| 400  | `POST /iam/roles`                                   | `permissionCodes` contains unknown entries (response lists which).                |
| 400  | `PATCH /iam/roles/:id`                              | Both `description` and `permissionCodes` omitted — "No-op patch".                |
| 400  | `PATCH /iam/roles/:id`                              | `permissionCodes` contains unknown entries.                                       |
| 400  | `POST /iam/staff/:id/roles`                         | `roleNames` references an unknown role (response lists which).                    |
| 404  | `PATCH /iam/roles/:id`                              | Role id does not exist.                                                           |
| 404  | `POST /iam/staff/:id/roles`                         | StaffUser id does not exist, or status is `suspended`.                            |
| 404  | `DELETE /iam/staff/:id/roles/:roleName`             | StaffUser id does not exist.                                                      |
| 404  | `DELETE /iam/staff/:id/roles/:roleName`             | StaffUser exists but does not currently have `:roleName` — "Role not bound".     |
| 409  | `POST /iam/roles`                                   | `name` collides with an existing role.                                            |
| 409  | `DELETE /iam/staff/:id/roles/:roleName`             | Would remove the last remaining role — "Cannot revoke the last remaining role". |

The choices follow the standard semantics: 409 is "your request would
create an invalid state and the resource exists"; 400 is "the input is
malformed or references nothing"; 404 is "the resource you addressed
isn't there." The "role-not-bound" case is intentionally 404 (not 204)
so the caller can disambiguate a typo from a successful revoke — the
caller probably has a stale UI either way, and a silent no-op masks
that.

## 4. Concurrency

All multi-row mutations are wrapped in a transaction at the **adapter**
layer, not the use case (the architecture lint forbids `typeorm` imports
in `application/`, ADR-017 §4). Two adapter methods open transactions:

- `RoleTypeormRepository.replacePermissions(role, codes)` — clears the
  role's `role_permissions` rows and inserts the new bindings inside one
  `entityManager.transaction(...)`. Observers reading the join table
  cannot see a transient empty set.
- `RoleTypeormRepository.save(role)` — does a single `repository.save`,
  which TypeORM treats as one atomic statement for the row + its `@JoinTable`.
- `StaffUserTypeormRepository.save(user)` — same pattern for
  `staff_user_roles`. The assign/revoke use cases call `save(user)` once
  with the post-mutation role list; TypeORM diffs the join rows and
  emits one INSERT and zero-or-one DELETE.

Concurrency model is last-writer-wins. There is no `version` column on
`role` or `staff_user`; optimistic-concurrency checks are explicitly
deferred to future concurrency-control work. Until then, two simultaneous PATCHes that disagree
on the final permission set will both succeed and the later commit
wins. For the IAM admin surface this is acceptable — operator
mutations are rare and human-initiated.

## 5. Idempotency on assign

`POST /api/iam/staff/:id/roles` is idempotent at the domain level:
`StaffUser.assignRole(role)` short-circuits when the role is already on
the user. The use case computes the post-resolution diff (which role
names were *actually* added after dedupe) and only emits a
`StaffUserRolesAssignedEvent` when that diff is non-empty.

This is important for retried POSTs — until idempotency-key support
ships, the safest behavior at the domain boundary is
that re-running the same `roleNames` payload always converges to the
same state with no side-effects.

## 6. Audit-log call sites

The five use cases each represent an auditable mutation. The
`AUDIT_LOG_PUBLISHER` port wraps the call sites these use cases add —
`CreateRoleUseCase`, `UpdateRoleUseCase`, `AssignStaffRoleUseCase`,
`RevokeStaffRoleUseCase` — in `AUDIT_LOG_PUBLISHER.publish(...)` calls.
The port was bound to a log-only no-op when these use cases landed, so
that the call sites existed before there was anything behind them; it is
now bound to `AuditLogRabbitmqPublisher`, which mirrors each event onto
the `ris.events` topic exchange under `audit.staff.action`.

The two domain events these use cases raise
(`StaffUserRolesAssignedEvent`, `StaffUserRoleRevokedEvent`, in
`apps/api-gateway/src/modules/auth/domain/events/`) are attached to the
aggregate's pending events queue and drained by the repository on save.

## 7. Why a separate `iam` module

Auth owns the `Role`, `Permission`, and `StaffUser` aggregates. IAM
owns the admin-side orchestration that mutates them. Keeping the
modules separate prevents auth from depending on the IAM admin DTOs —
which would force every test of the auth domain to import IAM
scaffolding. It also keeps the auth module's controller surface
focused on the buyer/staff sign-in flow; the IAM controller is for a
different audience (operators) with a different gate (`iam:*` codes,
not the JWT-only `@CurrentUser` paths).

The IAM module is a thin presentation-and-orchestration shell — no
`domain/` folder of its own — and reuses auth's repository adapters
via the three DI tokens that `AuthModule` re-exports
(`ROLE_REPOSITORY`, `PERMISSION_REPOSITORY`, `STAFF_USER_REPOSITORY`).
The architecture lint allows this: cross-module imports between
sibling modules under the same app are permitted when they go through
the module's barrel.

## 8. Files

New under `apps/api-gateway/src/modules/iam/`:

- `iam.module.ts` + `index.ts` (barrel).
- `application/dto/{create-role,update-role,assign-staff-role,revoke-staff-role}.command.ts`.
- `application/use-cases/{list-roles,create-role,update-role,assign-staff-role,revoke-staff-role}.use-case.ts`.
- `application/use-cases/spec/*.spec.ts` (five unit specs + test-doubles).
- `presentation/iam.controller.ts`.
- `presentation/dto/{create-role,update-role,assign-staff-role}.request.dto.ts` + `{role,staff-roles}.response.dto.ts`.

Modified:

- `apps/api-gateway/src/app/app.module.ts` — imports `IamModule`.
- `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts` —
  the `AuthLibModule.forRootAsync(...)` dynamic module is now captured
  in a constant and re-exported from `AuthModule.exports[]` so that
  `STAFF_USER_REPOSITORY` propagates to IAM. (NestJS does not let an
  outer module re-export an individual token from an imported dynamic
  module; the workaround is to re-export the whole module.)
- `apps/api-gateway/src/modules/auth/index.ts` — re-exports the three
  repository tokens, the three aggregates, and the two new events.
- `apps/api-gateway/src/modules/auth/application/ports/role.repository.port.ts` —
  `IRoleRepositoryPort` extended with `findById` and `replacePermissions`.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/role-typeorm.repository.ts` —
  implements both new methods; `save` now resolves permission ids by
  code before persist (previous code-only DeepPartial silently skipped
  the join-table insert).
- `apps/api-gateway/src/modules/auth/domain/role.aggregate.ts` —
  `setDescription` method.
- `apps/api-gateway/src/modules/auth/domain/staff-user.model.ts` —
  `recordRolesAssigned` and `recordRoleRevoked` methods (record the
  event onto the aggregate's pending queue).
- `apps/api-gateway/src/modules/auth/domain/events/` — two new event
  classes + index barrel.

E2E: `test/iam.e2e-spec.ts` runs the full round-trip — admin creates a
custom role with `audit:read` → assigns it to a fixture staff user →
fixture user logs in → hits `/api/auth/admin/ping` (200) → admin
revokes the role → fixture user logs in → `/api/auth/admin/ping` (403).
