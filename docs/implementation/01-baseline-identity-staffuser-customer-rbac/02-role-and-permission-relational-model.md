# 02 — Role + Permission Relational Model

This document records the design of the relational RBAC schema. It is
the implementation-side companion to
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md),
which captures the architectural decision that the simple-array role
column on `user` is replaced by a relational `role` + `permission` +
`role_permissions` model.

## 1. Why a relational model

The pre-existing schema stored roles as a `simple-array` column on `user`
(then at `apps/api-gateway/src/modules/auth/infrastructure/persistence/user.entity.ts`
— that entity and its table were removed by the `staff_user` rename described in
[`01-staffuser-customer-split.md`](./01-staffuser-customer-split.md) §4).
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

The relational model makes the role set a runtime fact. The IAM admin
tooling lets an operator with `iam:role-edit` mutate `role_permissions`
rows through a controller, and the change takes effect on the next JWT
refresh — no redeploy required.

## 2. Schema rationale

### `role`

```sql
CREATE TABLE role
(
    id          CHAR(36) PRIMARY KEY,
    name        VARCHAR(64) NOT NULL UNIQUE,
    description VARCHAR(255) NULL,
    created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

- **`id` as `CHAR(36)`** matches `user.id` so a future
  `staff_user_roles` join stays in one ID family across the
  module. The seed allocates deterministic UUIDs from the
  `00000000-0000-4000-c000-…` namespace so fixtures can reference them.
- **`name VARCHAR(64) UNIQUE`** fits the four canonical kebab-case names
  (`admin`, `catalog-manager`, `warehouse-staff`, `order-support`) with
  ample headroom. The `RoleAggregate.name` regex `^[a-z][a-z0-9-]*$` is
  enforced in the domain and is wider than the seeded set so admin
  tooling can introduce new names without a domain edit.

### `permission`

```sql
CREATE TABLE permission
(
    id          CHAR(36) PRIMARY KEY,
    code        VARCHAR(64) NOT NULL UNIQUE,
    description VARCHAR(255) NULL,
    created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

- **`code VARCHAR(64) UNIQUE`** matches the regex
  `^[a-z][a-z-]*:[a-z][a-z-]*$`. Sixty-four bytes is enough for any
  realistic `<resource>:<action>` pair (the longest seeded by this epic is
  `inventory:transfer`, 18 bytes; later epics added longer ones — the longest
  today is `inventory:receive-return`, 24 bytes). The code is the human-readable
  identifier; the UUID is the join-table foreign key.

### `role_permissions`

```sql
CREATE TABLE role_permissions
(
    role_id       CHAR(36) NOT NULL,
    permission_id CHAR(36) NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES role (id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permission (id) ON DELETE CASCADE
);
```

- **Composite PK** prevents duplicate `(role_id, permission_id)` rows at
  the database layer — `RoleAggregate.addPermission(code)` is also a
  Set-backed no-op at the domain layer, but the DB constraint is the
  durable contract.
- **`ON DELETE CASCADE`** on both foreign keys ensures that deleting a
  `role` or a `permission` does not leave dangling bindings. Note there is
  **no delete-role route** on the IAM surface today (see
  [`05-iam-admin-endpoints.md`](./05-iam-admin-endpoints.md) §1) — the cascade
  here is purely about schema cleanliness (e.g. a direct-SQL cleanup or a future
  delete path), not a policy an existing use case enforces.
- Charset is `utf8mb4_unicode_ci` to match every other table in the
  schema; the `simple-array` `user.roles` column is dropped when `user`
  is renamed to `staff_user`.

## 3. Permission code list (seeded)

| Code                 | Description                         |
|----------------------|-------------------------------------|
| `catalog:read`       | Read catalog                        |
| `catalog:write`      | Create or update catalog items      |
| `catalog:publish`    | Publish catalog items               |
| `inventory:read`     | Read inventory levels               |
| `inventory:adjust`   | Adjust inventory quantities         |
| `inventory:transfer` | Transfer inventory between storages |
| `order:read`         | Read orders                         |
| `order:cancel`       | Cancel orders                       |
| `order:refund`       | Refund orders                       |
| `iam:assign`         | Assign roles to staff users         |
| `iam:role-edit`      | Edit role-permission bindings       |
| `audit:read`         | Read audit log                      |

These are the twelve codes **this epic** introduced into `PermissionCodeEnum`
(`libs/contracts/auth/permission.enum.ts`). The enum is the single source
of truth — the seed reads its values directly, the
`@RequiresPermission(<code>)` decorator accepts the enum, and
the IAM admin tooling validates against the enum keyset before
inserting into `role_permissions`.

**The registry has since grown to 22 codes.** Later epics added `pricing:write`,
`order:capture`, `order:fulfill`, `order:return-authorize`,
`inventory:receive-return`, `notifications:read`, `notifications:write`,
`customer:read-consent`, `customer:erase` and `iam:staff-create` (ADR-047). The
table above is the epic-01 floor, not today's full list — read the enum for that.

## 4. Role-to-permission bindings (seeded)

| Role (`role.name`) | Permission codes                                                |
|--------------------|-----------------------------------------------------------------|
| `admin`            | every code in `PermissionCodeEnum` (12 bindings then; 22 today) |
| `catalog-manager`  | `catalog:read`, `catalog:write`, `catalog:publish`              |
| `warehouse-staff`  | `inventory:read`, `inventory:adjust`, `inventory:transfer`      |
| `order-support`    | `order:read`, `order:cancel`, `order:refund`                    |

Twenty-four `role_permissions` rows at the time of this epic. The seed uses
`INSERT IGNORE` on every `permission` / `role` / `role_permissions` statement, so
running `yarn test:seed` twice produces no duplicate-key errors and no duplicate
rows.

**Today the seed writes 38 rows.** Later epics widened both the registry and three
of the four bundles: `admin` binds `Object.values(PermissionCodeEnum)` (22),
`catalog-manager` 4 (it gained `pricing:write`), `warehouse-staff` 6 and
`order-support` 6. `ROLE_SEEDS` in `scripts/test-db-seed.ts:144` is the
authoritative list.

## 5. The JWT inflation path (preview)

At login time, `LoginUseCase` embeds `permissions: string[]` in the access JWT
payload. **As implemented**, the union is not assembled inside the use case: the
`StaffUser` the repository returns already carries its `RoleAggregate[]`, and the
merge lives on the aggregate as the `permissionCodes` getter
(`apps/api-gateway/src/modules/auth/domain/staff-user.model.ts:96`), which
`LoginUseCase` merely reads — so login and refresh cannot compute it differently.
`IRoleRepositoryPort.findAllByNames(...)` still exists, but it serves the IAM
role-assign path, not the login path. The relational schema
makes this inflation deterministic — one `SELECT … JOIN role_permissions`
per login resolves the full effective permission set. Guards
then read `request.user.permissions` without a per-request DB hit; the
trade-off is that a permission change does not take effect until the
user's next refresh (the JWT TTL is the staleness window). This is the
standard latency-vs-freshness shape for JWT-embedded authorization and
is recorded in [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
Decision §3.

## 6. What this work did NOT do

This schema work is strictly additive. It does **not**:

- Rename `user` → `staff_user`, drop the `simple-array` `roles` column,
  or add the `staff_user_roles` join. Those land with the `StaffUser`
  rename and aggregate.
- Inflate the access JWT with `permissions: string[]` — that is the
  JWT-inflation work (`LoginUseCase` + `RefreshTokenUseCase` updates).
- Add the `PermissionsGuard` or the `@RequiresPermission(<code>)`
  decorator — those land with the guard + decorator work, after the JWT
  carries the inflated list.
- Introduce the `Customer` aggregate or the public registration route —
  those are part of the Customer-side work.
- Expose IAM admin endpoints for mutating role-permission bindings — that
  is the IAM admin endpoints work.

The new tables exist, the enum and four seeded roles exist, the new
domain aggregates compile alongside the surviving `RoleVO` — but no
controller, guard, or use case reads them yet.
