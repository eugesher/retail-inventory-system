# 01 — StaffUser / Customer split (staff half)

This document records the design of the StaffUser side of the identity
split landed in epic-01 task-02. The Customer half is appended by
task-05; both halves share this file because the two aggregates are
defined by what they are *not* to each other.

For the architectural decision this implements, see
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md);
the relational role / permission scaffolding it builds on is documented
in [02-role-and-permission-relational-model.md](./02-role-and-permission-relational-model.md).

## 1. Why split

The pre-epic `user` table doubled as **both** a workforce identity (the
human who logs into the back office) and a buyer identity (the customer
who places an order). Its `roles: simple-array` column mixed two
ontologies into one list of strings:

| Value      | Ontology                       |
| ---------- | ------------------------------ |
| `admin`    | Workforce role (RBAC)          |
| `customer` | "This row is a buyer, not staff" |

Two consequences follow:

1. **The role guard is fooled.** `@Roles(RoleEnum.ADMIN, RoleEnum.CUSTOMER)`
   reads as "any authenticated principal" once you realize that *every*
   row carries either `admin` or `customer`. There is no rejection path
   the decorator can express that means "buyer principals only — not
   internal staff."
2. **Audit-log discipline is impossible.** Every action attributed to a
   StaffUser must hang off a stable, never-recycled internal ID that is
   distinct from any buyer ID — see the epic's "Architectural Decisions
   Honored" §Q7. With a single `user.id` namespace, deleting a buyer
   row and reusing its UUID later (e.g. GDPR erasure followed by a new
   signup at the same address) would silently re-attach historical
   admin-side actions to the new buyer. Splitting the namespaces
   forecloses the failure mode at the schema level.

The split is therefore *load-bearing* for two unrelated invariants
(authorization clarity and audit-log integrity); doing it once at the
schema layer is cheaper than threading either invariant through every
guard, log line, and controller.

## 2. The new `staff_user` shape

```sql
CREATE TABLE staff_user (
  id                 CHAR(36)                    PRIMARY KEY,
  email              VARCHAR(255)                NOT NULL UNIQUE,
  password_hash      VARCHAR(255)                NOT NULL,
  status             ENUM('active','suspended')  NOT NULL DEFAULT 'active',
  last_login_at      TIMESTAMP                   NULL,
  refresh_token_hash VARCHAR(255)                NULL,
  created_at         TIMESTAMP                   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP                   NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                 ON UPDATE CURRENT_TIMESTAMP,
  deleted_at         TIMESTAMP                   NULL
);
```

A few specific column choices to justify:

- **`status ENUM('active','suspended')` rather than a boolean
  `is_active`.** The MVP needs exactly two states, but the column is an
  enum (not a bit) because the realistic third state — `terminated` —
  is one schema-evolution step away and a boolean would lose the
  ability to distinguish "former employee whose account is shut" from
  "current employee on a temporary suspension." The domain returns
  `isActive = status === 'active' && deleted_at === null`, so a
  suspended row is *also* not active — that intersection is the
  authoritative gate, not the column on its own.
- **`last_login_at TIMESTAMP NULL` joins the table.** A "last login"
  observation is single-valued (always overwrite, never append), small,
  and read on every `auth/me` response — keeping it as a column on
  `staff_user` is cheaper than a separate `staff_user_login_event`
  table. The richer audit timeline lives in a future immutable log
  (epic-13 owns it); `last_login_at` is the cheap freshness signal,
  not the audit source of truth.
- **Soft-delete via `deleted_at`, not a hard row delete.** Audit logs
  outlive the staff member's tenure — `audit_log.actor_id` rows from
  2024 still need to resolve to a `staff_user.id` in 2026 even after
  the human leaves the company. Hard-deleting the row would either
  break the FK or force every audit-log row to denormalize the actor's
  email, both worse than carrying a `deleted_at` tombstone.
- **`refresh_token_hash` carries forward unchanged from the pre-epic
  table.** ADR-010's rotation-reuse protection is decoupled from the
  rename; the column moves verbatim from `user` to `staff_user` with
  no schema change.

## 3. From `simple-array` roles to `staff_user_roles`

The old `user.roles` column was a `VARCHAR(255)` of comma-separated
role names — the `simple-array` TypeORM type. That shape forced
*every* role mutation to read the row, edit a string in application
code, and write the row back. There was no SQL-level way to ask "every
staff user with the `catalog-manager` role" without table-scanning.

The replacement is the relational join `staff_user_roles`:

```sql
CREATE TABLE staff_user_roles (
  staff_user_id CHAR(36) NOT NULL,
  role_id       CHAR(36) NOT NULL,
  PRIMARY KEY (staff_user_id, role_id),
  FOREIGN KEY (staff_user_id) REFERENCES staff_user (id) ON DELETE CASCADE,
  FOREIGN KEY (role_id)       REFERENCES role       (id) ON DELETE CASCADE
);
```

- **Composite PK** is the durable contract that prevents a duplicate
  `(staff_user_id, role_id)` row. The domain-side `StaffUser.assignRole`
  is also idempotent (match by `role.id`), but the DB constraint
  outlives any single application path.
- **`ON DELETE CASCADE` on both FKs** lets the application delete a
  staff user (hard delete, in administrative tooling) or a role
  without leaving dangling join rows. Soft-delete via `deleted_at`
  does *not* trigger the cascade — that is intentional, because audit
  trails want the bindings preserved alongside the soft-deleted user.
- **`RoleEnum` is now just the typed registry of *seeded* names.**
  `libs/contracts/auth/role.enum.ts` carries `ADMIN`, `CATALOG_MANAGER`,
  `WAREHOUSE_STAFF`, `ORDER_SUPPORT` so TypeScript callers can write
  `RoleEnum.ADMIN` rather than the literal string `'admin'`. The
  source of truth for *which roles exist* is the `role` table — admin
  tooling (task-06) can insert a new row at runtime without a
  redeploy. `RoleEnum` is a developer ergonomic, not the schema.

The `RoleVO` value object that used to wrap a `RoleEnum` is **deleted**
in this task. `StaffUser.roles: RoleAggregate[]` references
`RoleAggregate` directly — the same object the role registry returns.
That carries the embedded permissions set into the StaffUser without
a second lookup, which is what makes task-03's JWT-inflation work cheap.

## 4. Migration shape

The migration `1779901877394-RenameUserToStaffUserAndDropRolesArray`
is destructive on the `user` table:

```ts
public async up(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query('DROP TABLE user;');
  await queryRunner.query(`CREATE TABLE staff_user (...)`);
  await queryRunner.query(`CREATE TABLE staff_user_roles (...)`);
}
```

The epic explicitly permits the drop:

> *"destructive changes to the old `user` table are permitted (no data
> to preserve)"*

— epic-01 §Migration Strategy. There is no production deploy yet; the
only inhabitants of `user` were two seeded test fixtures, and one of
them (`customer@example.com`) is moving to a different table in
task-05 anyway. A schema-rewrite migration that drops and re-creates is
materially simpler than the multi-step "create staff_user, copy rows,
drop user" shape a live-data migration would require, and the simpler
shape is also easier to roll back: `down()` drops the new tables and
re-creates `user` with the original column list, so a `migration:revert`
restores the previous-task schema cleanly.

## 5. Forward references

- **Task-03 (JWT inflation).** The access JWT payload will gain a
  `permissions: string[]` field next to the existing `roles: RoleEnum[]`.
  `LoginUseCase` and `RefreshTokenUseCase` will compute the union of
  every assigned role's permission set at issue time, so guards
  (task-04) can read `request.user.permissions` without a per-request
  DB hit. The latency-vs-freshness trade-off is recorded in ADR-024
  §Decision-3.
- **Task-05 (Customer half).** This document gets its second half
  appended below the anchor — the Customer aggregate lands in its own
  `customer` table, registration becomes public for buyers
  (`POST /api/auth/customer/register`), and the deferred
  `customer@example.com` seed re-appears against that table.
- **Future ConsentRecord + tombstone work (epic-13).** GDPR-style
  erasure of a `staff_user` row is *not* implemented here — the
  policy decision (full delete vs. tombstone vs. consent-scoped
  retention) is epic-13's. For now, `deleted_at` is a soft tombstone
  that keeps audit-log FKs resolvable; epic-13 will decide what
  follows.

<!-- customer-half-anchor -->
