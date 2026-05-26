---
epic: epic-01
task_number: 2
title: Rename `user` → `staff_user`, drop `roles: simple-array`, add `staff_user_roles` join, replace `User` aggregate with `StaffUser`
depends_on: [task-01]
doc_deliverable: docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/01-staffuser-customer-split.md
---

# Task 02 — Rename `user` → `staff_user`, drop `simple-array` roles, add `staff_user_roles`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Convert the `User` aggregate into `StaffUser` and the `user` table into `staff_user`. Drop the `roles: simple-array` column and replace it with a relational `staff_user_roles` join that points at the `role` table seeded in task-01. Delete `RoleVO` — the domain now references `RoleAggregate` (from task-01) directly. Repoint every existing import site (auth use cases, admin controller, JWT strategy, mapper, repo, test setup) to the new names. Add a `status` enum column and a `last_login_at` column per the epic.

This task is **destructive on the schema** — the `user` table goes away. The epic explicitly permits this ("destructive changes to the old `user` table are permitted (no data to preserve)").

## Entry state assumed

Task-01 carryover present on disk:

- `RoleEntity`, `PermissionEntity`, `role_permissions` join table exist in the schema; `role` and `permission` rows are seeded.
- `RoleAggregate`, `PermissionAggregate` compile alongside the existing `RoleVO`.
- `ROLE_REPOSITORY` / `PERMISSION_REPOSITORY` DI tokens are bound to TypeORM adapters in `auth.module.ts`.
- `libs/contracts/auth/permission.enum.ts` exists and is re-exported.
- The existing `User` aggregate, `RoleVO`, `UserEntity` (with `roles: simple-array`), `UserTypeormRepository`, `UserMapper`, and `ValidateUserUseCase` are untouched.
- `scripts/test-db-seed.ts` seeds permissions + roles but still seeds users into the `user` table with the simple-array `roles` column.

## Scope

**In:**

- Rename `User` → `StaffUser` (domain aggregate, entity, mapper, repository, ports, use cases, controller imports, spec files, test fixtures).
- Replace the `roles: RoleVO[]` field with `roles: RoleAggregate[]` (which carries embedded permissions).
- Add `status: 'active' | 'suspended'` and `last_login_at TIMESTAMP NULL` to the domain + entity + migration.
- New `staff_user_roles` join table (composite PK `(staff_user_id, role_id)`, `ON DELETE CASCADE`).
- Drop `RoleVO` (`apps/api-gateway/src/modules/auth/domain/role.model.ts`) and its consumers — `RoleAggregate` is the replacement.
- A fresh migration that DROPs the old `user` table and CREATEs the new `staff_user` + `staff_user_roles` tables. (The epic allows the simple `DROP+CREATE` shape since there is no data to preserve.)
- Update `scripts/test-db-seed.ts` `seedUsers` to write to `staff_user` and to populate `staff_user_roles` for the two existing fixture users (admin gets `admin` role; the current `customer@example.com` row is **deferred** — it moves to the `customer` table in task-05, and the corresponding seed line is moved there in task-09).
- Update `libs/contracts/auth/role.enum.ts` to enumerate the four canonical role names (`ADMIN = 'admin'`, `CATALOG_MANAGER = 'catalog-manager'`, `WAREHOUSE_STAFF = 'warehouse-staff'`, `ORDER_SUPPORT = 'order-support'`). This is the "typed registry of *seeded* role names" the epic describes; the source of truth becomes the `role` table.
- Doc deliverable (staff half) `01-staffuser-customer-split.md`.

**Out:**

- JWT payload shape changes — task-03 (this task keeps `payload.roles: RoleEnum[]`, with the values now being the four new role names).
- `PermissionsGuard` and `@RequiresPermission()` — task-04.
- Customer aggregate, customer table, customer endpoints — task-05.

## Files to add

- `apps/api-gateway/src/modules/auth/domain/staff-user.model.ts` — `StaffUser extends AggregateRoot<string>` with `email` (validated + lowercased), `passwordHash`, `status: 'active' | 'suspended'`, `lastLoginAt: Date | null`, `roles: RoleAggregate[]`, `refreshTokenHash: string | null`, `createdAt`, `updatedAt`, `deletedAt`. Methods: `register(...)`, `rehydrate(...)`, `assignRole(role: RoleAggregate)` (idempotent — match by `role.id`), `revokeRole(role)` (refuses to remove the last role), `suspend()`, `reactivate()`, `recordLoggedIn()` (mutates `lastLoginAt` and emits `StaffUserLoggedInEvent`), `rotateRefreshTokenHash(hash | null)`, `validatePassword(candidate, hasher)`. Computed `isActive` returns `status === 'active' && deletedAt === null`.
- `apps/api-gateway/src/modules/auth/domain/spec/staff-user.model.spec.ts` — invariants per epic §Test Strategy: email lowercased, status transitions valid, `passwordHash` never leaks via `toJSON` (assert via `JSON.stringify`), `assignRole` is idempotent, `revokeRole` refuses to remove the last role.
- `apps/api-gateway/src/modules/auth/domain/events/staff-user-logged-in.event.ts` — replaces `user-logged-in.event.ts` (delete the old).
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/staff-user.entity.ts` — `@Entity('staff_user')` with columns `id`, `email` (UNIQUE), `passwordHash`, `status` (`@Column({ type: 'enum', enum: ['active', 'suspended'], default: 'active' })`), `lastLoginAt` (nullable timestamp), `refreshTokenHash`, `createdAt`, `updatedAt`, `deletedAt`. Add `@ManyToMany(() => RoleEntity, { eager: false }) @JoinTable({ name: 'staff_user_roles', joinColumn: { name: 'staff_user_id' }, inverseJoinColumn: { name: 'role_id' } }) roles: RoleEntity[]`.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/staff-user.mapper.ts` — `toDomain`/`toEntity`. `toDomain` calls `RoleMapper.toDomain` on each loaded role so the `StaffUser`'s `roles: RoleAggregate[]` field carries the permissions set with it.
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/staff-user-typeorm.repository.ts` — implements `IStaffUserRepositoryPort`; every read uses `relations: ['roles', 'roles.permissions']`.
- `migrations/<ts>-RenameUserToStaffUserAndDropRolesArray.ts` — generated via `yarn migration:create migrations/RenameUserToStaffUserAndDropRolesArray`. The `up` runs `DROP TABLE user;` (no data preservation per the epic) and creates `staff_user` + `staff_user_roles` from scratch with the schema above. The `down` does the inverse for rollback safety.

## Files to modify

- `libs/contracts/auth/role.enum.ts` — replace today's two values with the four canonical role names:

  ```ts
  export enum RoleEnum {
    ADMIN = 'admin',
    CATALOG_MANAGER = 'catalog-manager',
    WAREHOUSE_STAFF = 'warehouse-staff',
    ORDER_SUPPORT = 'order-support',
  }
  ```

  Note: `CUSTOMER` is intentionally removed — Customer is no longer a "role" in the RBAC sense; it is a separate aggregate (task-05). The `IJwtAccessPayload.roles` field stays `RoleEnum[]` but its inhabitants now come from this set.
- `apps/api-gateway/src/modules/auth/application/ports/user.repository.port.ts` → **rename file to** `staff-user.repository.port.ts`. `IUserRepositoryPort` → `IStaffUserRepositoryPort`, `USER_REPOSITORY` → `STAFF_USER_REPOSITORY`, `User` → `StaffUser`.
- `apps/api-gateway/src/modules/auth/application/use-cases/*.use-case.ts` and their `spec/*.spec.ts` siblings — repoint all imports from `User` → `StaffUser`, `USER_REPOSITORY` → `STAFF_USER_REPOSITORY`. The `register-user.use-case.ts` stays but is now `register-staff-user.use-case.ts`; it accepts `roleNames: string[]` and resolves them via `IRoleRepositoryPort.findAllByNames` (rejecting unknown names). Also rename `validate-user.use-case.ts` → `validate-staff-user.use-case.ts` and its class to `ValidateStaffUserUseCase` (still implements `IAuthUserValidator`).
- `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts` — replace `UserEntity` → `StaffUserEntity` in `TypeOrmModule.forFeature`, replace `UserTypeormRepository` → `StaffUserTypeormRepository`, replace `USER_REPOSITORY` → `STAFF_USER_REPOSITORY` in providers/exports, replace `ValidateUserUseCase` → `ValidateStaffUserUseCase`. The new repos `ROLE_REPOSITORY` / `PERMISSION_REPOSITORY` registered in task-01 are now injected into `RegisterStaffUserUseCase`.
- `apps/api-gateway/src/app/app.module.ts` — `DatabaseModule.forRoot([UserEntity, RoleEntity, PermissionEntity])` → `DatabaseModule.forRoot([StaffUserEntity, RoleEntity, PermissionEntity])` (also fix the import in `apps/api-gateway/src/modules/auth/index.ts`).
- `apps/api-gateway/src/modules/auth/index.ts` — re-export `StaffUserEntity` instead of `UserEntity` (matching the existing barrel pattern).
- `apps/api-gateway/src/modules/auth/presentation/auth-admin.controller.ts` — no behaviour change yet (gated behind `@Roles(RoleEnum.ADMIN)`); just verify it still compiles against the new `RoleEnum` set.
- `scripts/test-db-seed.ts` — update `seedUsers` to write to `staff_user` (with new column shape: include `status = 'active'`, `last_login_at NULL`). Insert into `staff_user_roles` to bind admin@example.com to the `admin` role row (look up role id by name). **Remove the `customer@example.com` seed line entirely from this task** — task-05 will reintroduce it against the `customer` table.
- Existing spec files in `apps/api-gateway/src/modules/auth/application/use-cases/spec/*.spec.ts` — repoint test doubles (`test-doubles.ts`) to `StaffUser` shape, rename `MockUserRepository` → `MockStaffUserRepository`, and update assertion sites.
- `test/auth.e2e-spec.ts` — admin/customer login fixtures: admin keeps logging in via `/api/auth/login` (the old route remains a deprecated alias per the epic), customer login moves to task-05's `/api/auth/customer/login`. **In this task, comment out the `customer login` describe block and add a `TODO(task-05)` marker** — re-enable in task-05. Admin-side flow must keep passing.

## Files to delete

- `apps/api-gateway/src/modules/auth/domain/user.model.ts` (replaced by `staff-user.model.ts`).
- `apps/api-gateway/src/modules/auth/domain/role.model.ts` (the `RoleVO` is gone — `RoleAggregate` from task-01 is the replacement).
- `apps/api-gateway/src/modules/auth/domain/events/user-logged-in.event.ts` (replaced by `staff-user-logged-in.event.ts`).
- `apps/api-gateway/src/modules/auth/domain/events/user-registered.event.ts` (keep — it's a structural event still emitted by `StaffUser.register`, but renamed to `staff-user-registered.event.ts`).
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/user.entity.ts` (replaced by `staff-user.entity.ts`).
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/user.mapper.ts` (replaced).
- `apps/api-gateway/src/modules/auth/infrastructure/persistence/user-typeorm.repository.ts` (replaced).
- `apps/api-gateway/src/modules/auth/application/use-cases/spec/old test-double files specific to `User`` (only the renamed parts — keep the rest of the test scaffolding).

## Tests

- The renamed unit spec files (per "Files to modify"): all should pass against the new shape with the same coverage as before, plus the new `StaffUser` invariants per epic §Test Strategy.
- E2E:
  - `test/auth.e2e-spec.ts` admin flow continues to work end-to-end (login → refresh → me → logout) against the new `staff_user` table.
  - `test/auth-rotation` (epic §Test Strategy lists `test/auth-rotation.e2e-spec.ts`) — if it does not yet exist as a separate file, the existing rotation coverage inside `test/auth.e2e-spec.ts` is sufficient for this task; task-03 may split it into its own file when JWT inflation lands.

## Doc deliverable

Write `docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/01-staffuser-customer-split.md` — **staff half only**. Task-05 will append the customer half to the same file. Target ~120 lines for this half. Sections:

1. **Why split.** The conflated `user` table doubled as StaffUser + Customer with a `roles` column that mixed two ontologies (`admin` = staff role, `customer` = "this is a buyer not a staff member"). Audit-log discipline requires that every action attributed to a StaffUser have a stable, never-recycled internal id distinct from any buyer id — see the epic's "Architectural Decisions Honored" §Q7 / §audit-log discipline.
2. **The new `staff_user` shape.** Column list, `status` enum rationale (soft-delete-via-status, not row delete — staff actions persist in audit logs that outlive the staff member's tenure), why `last_login_at` joins the table (not a separate observation table — last-login is single-valued and cheap).
3. **From `simple-array` roles to `staff_user_roles`.** The join table is the source of truth; `RoleEnum` is now just the typed registry of *seeded* names so TypeScript code can refer to `RoleEnum.ADMIN` without magic strings.
4. **Migration shape.** The migration drops `user` and creates `staff_user` from scratch — explicitly cite the epic's allowance ("destructive changes to the old `user` table are permitted (no data to preserve)").
5. **Forward references.** One paragraph each to: task-03 (the JWT payload now carries permissions in addition to roles); task-05 (the customer half of this doc is appended by task-05); the future ConsentRecord/tombstone work owned by epic-13.

## Carryover produced

- `StaffUser`, `StaffUserEntity`, `StaffUserTypeormRepository`, `StaffUserMapper`, `IStaffUserRepositoryPort` / `STAFF_USER_REPOSITORY`, renamed use cases (`RegisterStaffUserUseCase`, `LoginUseCase` repointed, `RefreshTokenUseCase` repointed, `LogoutUseCase` repointed, `ValidateStaffUserUseCase`).
- `staff_user` + `staff_user_roles` tables in the schema.
- `RoleEnum` has the four canonical role names; `CUSTOMER` is gone from it.
- `RoleVO` and the old `user.entity.ts` and friends are deleted from the repo.
- Seed script writes one StaffUser (admin) to `staff_user` and binds the `admin` role.
- Doc `01-staffuser-customer-split.md` — staff half complete; customer half to be appended in task-05.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the renamed spec files + new `staff-user.model.spec.ts` are green.
- [ ] `yarn test:e2e` admin flow is green; the customer login block in `test/auth.e2e-spec.ts` is commented out with a `TODO(task-05)` marker.
- [ ] `yarn migration:run` applies cleanly on a fresh DB after a `migration:revert` of task-01; `yarn migration:revert` on task-02 restores the previous-task schema cleanly.
- [ ] `yarn seed` is idempotent and produces exactly one row in `staff_user` (admin) and one row in `staff_user_roles`.
- [ ] `mysql> DESCRIBE staff_user;` shows no `roles` column.
- [ ] The repo has zero references to `User` (the old class name), `UserEntity`, `UserTypeormRepository`, `UserMapper`, `RoleVO`, `USER_REPOSITORY` outside of the migration revert path. (`grep -rn "RoleVO\|UserEntity\|USER_REPOSITORY" apps/ libs/ test/ scripts/` returns nothing.)
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `01-staffuser-customer-split.md` exists with the staff half complete and an explicit anchor (`<!-- customer-half-anchor -->`) for task-05.
