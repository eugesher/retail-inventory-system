# 02 — Role + Permission Relational Model

This document records the design of the relational RBAC schema landed in
epic-01 task-01. It is the implementation-side companion to
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md),
which captures the architectural decision that the simple-array role
column on `user` is replaced by a relational `role` + `permission` +
`role_permissions` model.

## 1. Why a relational model

The pre-epic schema stored roles as a `simple-array` column on `user`
(see `apps/api-gateway/src/modules/auth/infrastructure/persistence/user.entity.ts`).
Two consequences follow from that shape:

1. **The role set is a TypeScript release artifact.** Adding a new role,
   renaming one, or rebinding a permission set requires editing
   `libs/contracts/auth/role.enum.ts` and shipping a redeploy. There is
   no path that lets an operator add `catalog-manager` to the system at
   runtime.
2. **There is no permission concept at all.** `RoleEnum` is the full
   authorization vocabulary — `@Roles(RoleEnum.ADMIN)` is the only knob.
   That collapses two different questions (*what role is this user?* vs.
   *what may this user do?*) into one.

The relational model makes the role set a runtime fact. Admin tooling
landed in task-06 will let an operator with `iam:role-edit` mutate
`role_permissions` rows through a controller, and the change takes
effect on the next JWT refresh — no redeploy required.

## 2. Schema rationale

### `role`

```sql
CREATE TABLE role (
  id          CHAR(36)     PRIMARY KEY,
  name        VARCHAR(64)  NOT NULL UNIQUE,
  description VARCHAR(255) NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP
);
```

- **`id` as `CHAR(36)`** matches `user.id` so a future
  `staff_user_roles` join (task-02) stays in one ID family across the
  module. The seed allocates deterministic UUIDs from the
  `00000000-0000-4000-c000-…` namespace so fixtures can reference them.
- **`name VARCHAR(64) UNIQUE`** fits the four canonical kebab-case names
  (`admin`, `catalog-manager`, `warehouse-staff`, `order-support`) with
  ample headroom. The `RoleAggregate.name` regex `^[a-z][a-z0-9-]*$` is
  enforced in the domain and is wider than the seeded set so admin
  tooling can introduce new names without a domain edit.

### `permission`

```sql
CREATE TABLE permission (
  id          CHAR(36)     PRIMARY KEY,
  code        VARCHAR(64)  NOT NULL UNIQUE,
  description VARCHAR(255) NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP
);
```

- **`code VARCHAR(64) UNIQUE`** matches the regex
  `^[a-z][a-z-]*:[a-z][a-z-]*$`. Sixty-four bytes is enough for any
  realistic `<resource>:<action>` pair (the longest seeded today is
  `inventory:transfer`, 18 bytes). The code is the human-readable
  identifier; the UUID is the join-table foreign key.

### `role_permissions`

```sql
CREATE TABLE role_permissions (
  role_id       CHAR(36) NOT NULL,
  permission_id CHAR(36) NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id)       REFERENCES role       (id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permission (id) ON DELETE CASCADE
);
```

- **Composite PK** prevents duplicate `(role_id, permission_id)` rows at
  the database layer — `RoleAggregate.addPermission(code)` is also a
  Set-backed no-op at the domain layer, but the DB constraint is the
  durable contract.
- **`ON DELETE CASCADE`** on both foreign keys ensures that deleting a
  `role` or a `permission` does not leave dangling bindings. Refusing to
  delete a role that is currently assigned to a `StaffUser` is enforced
  at the use-case level in task-06 (`DeleteRoleUseCase` returns 409 when
  `staff_user_roles` references the role) — cascade here is about
  schema cleanliness, not about the policy decision.
- Charset is `utf8mb4_unicode_ci` to match every other table in the
  schema; the `simple-array` `user.roles` column will be dropped in
  task-02.

## 3. Permission code list (seeded)

| Code                  | Description                                |
| --------------------- | ------------------------------------------ |
| `catalog:read`        | Read catalog                               |
| `catalog:write`       | Create or update catalog items             |
| `catalog:publish`     | Publish catalog items                      |
| `inventory:read`      | Read inventory levels                      |
| `inventory:adjust`    | Adjust inventory quantities                |
| `inventory:transfer`  | Transfer inventory between storages        |
| `order:read`          | Read orders                                |
| `order:cancel`        | Cancel orders                              |
| `order:refund`        | Refund orders                              |
| `iam:assign`          | Assign roles to staff users                |
| `iam:role-edit`       | Edit role-permission bindings              |
| `audit:read`          | Read audit log                             |

These are the values of `PermissionCodeEnum` in
`libs/contracts/auth/permission.enum.ts`. The enum is the single source
of truth — the seed reads its values directly, the future
`@RequiresPermission(<code>)` decorator (task-04) accepts the enum, and
admin tooling (task-06) validates against the enum keyset before
inserting into `role_permissions`.

## 4. Role-to-permission bindings (seeded)

| Role (`role.name`) | Permission codes                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`            | every code in §3 (12 bindings)                                                                                                                                                                                                  |
| `catalog-manager`  | `catalog:read`, `catalog:write`, `catalog:publish`                                                                                                                                                                              |
| `warehouse-staff`  | `inventory:read`, `inventory:adjust`, `inventory:transfer`                                                                                                                                                                      |
| `order-support`    | `order:read`, `order:cancel`, `order:refund`                                                                                                                                                                                    |

Twenty-four `role_permissions` rows total. The seed uses `INSERT IGNORE`
on every statement, so running `yarn test:seed` twice produces no
duplicate-key errors and no duplicate rows.

## 5. The JWT inflation path (preview)

At login time (task-03), `LoginUseCase` will resolve the authenticated
`StaffUser`'s roles via `IRoleRepositoryPort.findAllByNames(...)`,
collect the union of their `permissions` sets, and embed
`permissions: string[]` in the access JWT payload. The relational schema
makes this inflation deterministic — one `SELECT … JOIN role_permissions`
per login resolves the full effective permission set. Guards (task-04)
then read `request.user.permissions` without a per-request DB hit; the
trade-off is that a permission change does not take effect until the
user's next refresh (the JWT TTL is the staleness window). This is the
standard latency-vs-freshness shape for JWT-embedded authorization and
is recorded in [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
Decision §3.

## 6. What this task did NOT do

This task is strictly additive. It does **not**:

- Rename `user` → `staff_user`, drop the `simple-array` `roles` column,
  or add the `staff_user_roles` join. Those land in **task-02** along
  with the `StaffUser` aggregate.
- Inflate the access JWT with `permissions: string[]` — that is
  **task-03** (`LoginUseCase` + `RefreshTokenUseCase` updates).
- Add the `PermissionsGuard` or the `@RequiresPermission(<code>)`
  decorator — those land in **task-04**, after the JWT carries the
  inflated list.
- Introduce the `Customer` aggregate or the public registration route —
  those are **task-05**.
- Expose IAM admin endpoints for mutating role-permission bindings — that
  is **task-06**.

The new tables exist, the enum and four seeded roles exist, the new
domain aggregates compile alongside the surviving `RoleVO` — but no
controller, guard, or use case reads them yet.
