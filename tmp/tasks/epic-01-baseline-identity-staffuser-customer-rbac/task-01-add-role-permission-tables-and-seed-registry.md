---
epic: epic-01
task_number: 1
title: Add the relational Role + Permission tables and seed the permission code registry
depends_on: []
doc_deliverable: docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/02-role-and-permission-relational-model.md
---

# Task 01 — Add the relational `Role` + `Permission` tables and seed the permission code registry

## Goal

Introduce the relational RBAC schema (tables `role`, `permission`, `role_permissions`) and the single source of truth for permission codes (`libs/contracts/auth/permission.enum.ts`). This task is **strictly additive**: no controller behaviour changes, no existing endpoint is altered, no existing import is broken. The old `User` aggregate and its `RoleVO`/`simple-array` `roles` column remain untouched — they will be replaced in task-02 once the new tables and aggregates are in place.

After this task, the new tables exist in the schema, the canonical permission codes and the four seeded roles are present in the database, and the new domain aggregates (`RoleAggregate`, `PermissionAggregate`) compile alongside the existing `RoleVO` without conflict.

## Entry state assumed

Pristine repo at the commit `046d917 RIS-43 Top-level plan` (or any later commit on `main` that has not begun epic-01). Specifically:

- `apps/api-gateway/src/modules/auth/` follows the existing layout — `domain/role.model.ts` contains `RoleVO`, `infrastructure/persistence/user.entity.ts` has the `roles: simple-array` column, `application/use-cases/*` consume `RoleVO`.
- `libs/contracts/auth/role.enum.ts` defines `RoleEnum { ADMIN = 'admin', CUSTOMER = 'customer' }`.
- `migrations/` contains only `1772600000000-InitStarterEntities.ts`, `1774134626155-AddOrderProductIdToProductStock.ts`, `1778419765133-CreateUserTable.ts`.
- `scripts/test-db-seed.ts` seeds the two-user fixture (`admin@example.com`, `customer@example.com`).

## Scope

**In:**

- New permission code registry (single source of truth).
- New domain aggregates `RoleAggregate`, `PermissionAggregate` (these are different files from the existing `RoleVO` — they do **not** replace it yet).
- New TypeORM entities `RoleEntity`, `PermissionEntity` and the `role_permissions` join (modelled via TypeORM `@ManyToMany` with `@JoinTable` on `RoleEntity`).
- New repository ports + adapters for `Role` and `Permission` reads.
- A fresh migration that CREATEs the three tables.
- A seed-script extension that populates the permission code rows and the four canonical roles + their role-permission bindings — **but not the StaffUsers/Customers** (those come in task-09).
- Doc deliverable `02-role-and-permission-relational-model.md`.

**Out:**

- Touching `user.entity.ts`, `User`, `RoleVO`, `UserTypeormRepository`, `UserMapper`, any auth use case.
- Renaming `RoleEnum` (it stays as today; it's demoted from "source of truth" to "typed registry of seeded role names" only in task-02's narrative — the file content stays the same in task-01).
- The `staff_user_roles` join table (it's added in task-02 alongside the `staff_user` rename).
- Any guard, decorator, or controller change.

## Permission code registry — what to seed

The epic specifies a floor of 12 codes. Match the regex `^[a-z][a-z-]*:[a-z][a-z-]*$`. Codes:

`catalog:read`, `catalog:write`, `catalog:publish`, `inventory:read`, `inventory:adjust`, `inventory:transfer`, `order:read`, `order:cancel`, `order:refund`, `iam:assign`, `iam:role-edit`, `audit:read`.

Implement as an `enum` so consumers get type safety:

```ts
// libs/contracts/auth/permission.enum.ts
export enum PermissionCodeEnum {
  CATALOG_READ = 'catalog:read',
  CATALOG_WRITE = 'catalog:write',
  CATALOG_PUBLISH = 'catalog:publish',
  INVENTORY_READ = 'inventory:read',
  INVENTORY_ADJUST = 'inventory:adjust',
  INVENTORY_TRANSFER = 'inventory:transfer',
  ORDER_READ = 'order:read',
  ORDER_CANCEL = 'order:cancel',
  ORDER_REFUND = 'order:refund',
  IAM_ASSIGN = 'iam:assign',
  IAM_ROLE_EDIT = 'iam:role-edit',
  AUDIT_READ = 'audit:read',
}
```

Re-export it from `libs/contracts/auth/index.ts` and `libs/contracts/index.ts`.

## Role registry — what to seed

Four roles, each bound to the permission set its job implies:

| Role name (`role.name`) | Permission codes |
| --- | --- |
| `admin` | every permission code above (the floor list) |
| `catalog-manager` | `catalog:read`, `catalog:write`, `catalog:publish` |
| `warehouse-staff` | `inventory:read`, `inventory:adjust`, `inventory:transfer` |
| `order-support` | `order:read`, `order:cancel`, `order:refund` |

These four `name` values become the typed registry that `libs/contracts/auth/role.enum.ts` exposes in task-02. In task-01, only the `name` strings appear (in the seed-script extension), not as enum values yet.

## Files to add

- `libs/contracts/auth/permission.enum.ts` — see the enum above.
- `apps/api-gateway/src/modules/auth/domain/role.aggregate.ts` — `RoleAggregate extends AggregateRoot<string>` with `id`, `name` (validated kebab-case, regex `^[a-z][a-z0-9-]*$`), `description?`, `permissions: Set<PermissionCodeEnum>`. Static `RoleAggregate.create(...)`, `RoleAggregate.rehydrate(...)`. Methods `addPermission(code)`, `removePermission(code)`, `hasPermission(code): boolean`.
- `apps/api-gateway/src/modules/auth/domain/permission.aggregate.ts` — `PermissionAggregate` with `id`, `code` (validated by the regex above), `description?`. Static `create`/`rehydrate`.
- `apps/api-gateway/src/modules/auth/domain/spec/role.aggregate.spec.ts` — invariants: name regex enforced; permissions stored as a Set (duplicate `addPermission` is a no-op); `hasPermission` returns `false` for unbound codes.
- `apps/api-gateway/src/modules/auth/domain/spec/permission.aggregate.spec.ts` — code regex enforced (table-driven: valid + invalid cases including `Catalog:Read`, `catalog:`, `:read`, `catalog read`).
- `apps/api-gateway/src/modules/auth/application/ports/role.repository.port.ts` — `IRoleRepositoryPort` with `findByName(name): Promise<RoleAggregate | null>`, `findAllByNames(names: string[]): Promise<RoleAggregate[]>`, `findAll(): Promise<RoleAggregate[]>`, `save(role): Promise<RoleAggregate>`. Export `const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY')`.
- `apps/api-gateway/src/modules/auth/application/ports/permission.repository.port.ts` — `IPermissionRepositoryPort` with `findAll(): Promise<PermissionAggregate[]>`, `findByCodes(codes: string[]): Promise<PermissionAggregate[]>`. Export `const PERMISSION_REPOSITORY = Symbol('PERMISSION_REPOSITORY')`.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/role.entity.ts` — `@Entity('role')` with `@PrimaryColumn('char', { length: 36 }) id`, `@Column('varchar', { length: 64, unique: true }) name`, `@Column('varchar', { length: 255, nullable: true }) description`, `@ManyToMany(() => PermissionEntity, { eager: false, cascade: false }) @JoinTable({ name: 'role_permissions', joinColumn: { name: 'role_id' }, inverseJoinColumn: { name: 'permission_id' } }) permissions: PermissionEntity[]`.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/permission.entity.ts` — `@Entity('permission')` with `id` (CHAR(36) PK), `code` (VARCHAR(64) UNIQUE), `description` (VARCHAR(255) NULL).
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/role.mapper.ts` — `toDomain(entity)` / `toEntity(aggregate)` with permission set materialised from `entity.permissions`.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/permission.mapper.ts`.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/role-typeorm.repository.ts` — implements `IRoleRepositoryPort`, eagerly loads `permissions` via `relations: ['permissions']`.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/permission-typeorm.repository.ts` — implements `IPermissionRepositoryPort`.
- `migrations/<ts>-CreateRoleAndPermissionTables.ts` — `up`/`down` for:
  - `role(id CHAR(36) PK, name VARCHAR(64) NOT NULL UNIQUE, description VARCHAR(255) NULL, created_at TIMESTAMP, updated_at TIMESTAMP)`.
  - `permission(id CHAR(36) PK, code VARCHAR(64) NOT NULL UNIQUE, description VARCHAR(255) NULL, created_at TIMESTAMP, updated_at TIMESTAMP)`.
  - `role_permissions(role_id CHAR(36) NOT NULL, permission_id CHAR(36) NOT NULL, PRIMARY KEY (role_id, permission_id), FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE, FOREIGN KEY (permission_id) REFERENCES permission(id) ON DELETE CASCADE)`.
  - Charset `utf8mb4_unicode_ci`.
  - Generate via `yarn migration:create migrations/CreateRoleAndPermissionTables` and then fill the `up`/`down` bodies.
- `docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/02-role-and-permission-relational-model.md` — see "Doc deliverable" below.

## Files to modify

- `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts` — register the new entities under `TypeOrmModule.forFeature([UserEntity, RoleEntity, PermissionEntity])` and provide `RoleTypeormRepository` + `PermissionTypeormRepository` under `ROLE_REPOSITORY` / `PERMISSION_REPOSITORY`. The new repositories should be available to the module but no use case consumes them yet — they're prerequisites for task-02 (which uses them when rehydrating a `StaffUser` with its roles).
- `apps/api-gateway/src/app/app.module.ts` — extend `DatabaseModule.forRoot([UserEntity])` to `DatabaseModule.forRoot([UserEntity, RoleEntity, PermissionEntity])`.
- `scripts/test-db-seed.ts` — add `seedPermissions(connection)` (INSERT IGNORE one row per `PermissionCodeEnum` value, deterministic UUID per code) and `seedRoles(connection)` (INSERT IGNORE the four canonical roles with deterministic UUIDs, plus INSERT IGNORE into `role_permissions` per the table in "Role registry — what to seed"). Call both before `seedUsers`. Do **not** touch the existing `seedUsers` body in this task.
- `libs/contracts/auth/index.ts` — `export * from './permission.enum';`.

## Files to delete

None.

## Tests

- `apps/api-gateway/src/modules/auth/domain/spec/role.aggregate.spec.ts` and `permission.aggregate.spec.ts` as listed above.
- No new e2e or repo integration test in this task — the new tables are unused by any HTTP route until task-04 onward. The migration `up`/`down` round-trip and the seed extension are verified manually:
  - `yarn migration:run` should apply cleanly on a fresh schema.
  - `yarn migration:revert` should drop the three tables cleanly.
  - `yarn seed` should INSERT the 12 permission rows and 4 role rows; running it twice should be idempotent (no UNIQUE constraint errors thanks to `INSERT IGNORE` or `ON DUPLICATE KEY UPDATE`).

## Doc deliverable

Write `docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/02-role-and-permission-relational-model.md` with these sections (target length: ~150 lines):

1. **Why a relational model.** The simple-array column couples role definitions to TypeScript releases (changing the role set requires a redeploy). A relational table makes the role set a runtime fact, addressable from admin tooling (task-06).
2. **Schema rationale.** Why `role.name` is `VARCHAR(64)` (kebab-case slug, fits 4 canonical names + future additions), why `permission.code` is `VARCHAR(64)` (matches the regex), why `ON DELETE CASCADE` on the join (a deleted Role/Permission should not leave dangling bindings; refusal-to-delete is enforced at the use-case level in task-06).
3. **Permission code list.** Table mirroring "Permission code registry" above.
4. **Role-to-permission bindings.** Table mirroring "Role registry" above.
5. **The JWT inflation path (preview).** A one-paragraph forward reference: at login time (task-03), the access JWT will carry `permissions: string[]` so guards (task-04) don't need a DB hit per request. The relational schema makes this inflation deterministic — `JOIN role_permissions` once per login.
6. **What this task did NOT do.** Cross-references to task-02 (rename), task-03 (JWT inflation), task-04 (guard).

## Carryover produced (consumed by task-02 onward)

- New TypeORM entities `RoleEntity`, `PermissionEntity` registered in `auth.module.ts` and `DatabaseModule.forRoot([...])`.
- New domain aggregates `RoleAggregate`, `PermissionAggregate` (siblings of the surviving `RoleVO`).
- New repository ports + adapters wired to DI tokens `ROLE_REPOSITORY` / `PERMISSION_REPOSITORY`.
- New migration adds three tables; seed script populates 12 permissions + 4 roles + 24 role_permission bindings.
- `libs/contracts/auth/permission.enum.ts` and its re-export.
- Doc `02-role-and-permission-relational-model.md`.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the two new domain spec files are green.
- [ ] `yarn migration:run` applies cleanly on a fresh DB; `yarn migration:revert` drops the new tables cleanly.
- [ ] `yarn seed` is idempotent — running it twice produces no errors and no duplicate rows in `role`, `permission`, or `role_permissions`.
- [ ] The existing `yarn test:e2e` suite still passes (no regression — task-01 is additive).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `02-role-and-permission-relational-model.md` exists at the path above and is filled per the section list.
