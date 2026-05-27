# ADR-024: RBAC v2 — StaffUser/Customer split and a relational permission model

- **Date**: 2026-05-27
- **Status**: Accepted (supersedes ADR-010 §4, §5, §7, and the Consequences `RoleEnum` discussion)

---

## Context

[ADR-010](010-jwt-rbac-at-the-gateway.md) landed JWT authentication and
RBAC at the gateway with a deliberately minimal authorization model:

- A single `User` aggregate (`apps/api-gateway/src/modules/auth/domain/user.model.ts`)
  with a `roles: RoleVO[]` field, persisted as a `simple-array` column
  on `user.roles` (ADR-010 §4 — "Aggregate boundary").
- A two-guard composition (`JwtAuthGuard → RolesGuard`) keyed off
  `RoleEnum { ADMIN, CUSTOMER }` (ADR-010 §5 — "Authorization model").
- Public registration explicitly deferred until rate-limiting,
  email-verification, and CAPTCHA exist (ADR-010 §7 — "Registration").
- The closing Consequences section noted "no further indirection is
  warranted today" — meaning no `permission` table, no role/permission
  separation.

That model was right for the audit baseline. It does not survive epic-01,
which has four hard requirements ADR-010 did not anticipate:

1. **Different lifecycles for staff and customers.** A warehouse worker is
   onboarded by an admin, may have no purchase history, and is
   soft-deleted via a `status` column when they leave. A customer
   self-registers, may have order rows that outlive their account, and
   needs tombstone-friendly nullability on the FK to `order.customer`.
   One `User` aggregate with a `kind` discriminator collapses two
   independent lifecycles into a switch statement that grows on every
   change.
2. **Permissions, not just roles.** The four canonical job titles
   (`admin`, `catalog-manager`, `warehouse-staff`, `order-support`) each
   imply a different *set* of fine-grained capabilities. Storing
   `@Roles(RoleEnum.X)` on every route means renaming a role rebinds
   every endpoint; introducing a fifth role means editing every guard
   call site that should also accept it. The mapping must live in the
   data layer, not in the controllers.
3. **Runtime mutability.** Task-06 ships an IAM admin controller that
   lets an operator with `iam:role-edit` add or remove a permission from
   a role at runtime. ADR-010's `simple-array` column makes this
   impossible without a redeploy.
4. **Customer-side public register.** Epic-01 ships `POST /auth/customer/register`
   as `@Public()`. ADR-010 §7's deferral is the right default; epic-01
   needs to record the *decision* to relax it (and which of the three
   safeguards — rate-limiting, email verification, CAPTCHA — actually
   land in-epic vs. become "known gap" follow-ups).

This ADR records the cumulative architectural decision that supersedes
ADR-010's RBAC model. The first concrete step (the relational schema and
permission code registry) lands in epic-01 task-01; subsequent tasks
implement the aggregates, JWT inflation, guards, and admin controller.

## Decision

### 1. Aggregate split: `User` → `StaffUser` + `Customer`

Two aggregates, not one with a `kind` discriminator.

- `StaffUser` lives behind an admin onboarding flow. Persistence has a
  non-nullable `status` column (active / suspended / disabled) and a
  many-to-many `staff_user_roles` join to `role`. There is no public
  registration path.
- `Customer` lives behind `POST /auth/customer/register` (see §4) and is
  the FK target of `order.customer`. The `customer.id` column on
  `order` becomes nullable so deleting a customer leaves an order
  tombstone rather than failing the constraint.

ADR-010 §4 anticipated this split in spirit ("a future store manager
admin may have no `customer` row, and a customer who churns may need to
keep an order tombstone") but committed to a single `User` for the audit
baseline. This ADR commits the implementation.

The split lands in **task-02** (rename `user` → `staff_user`, add
`staff_user_roles`, drop the `simple-array` `roles` column) and
**task-05** (`Customer` aggregate, public registration, nullable
`order.customer_id`).

### 2. Relational role + permission model

Three new tables replace ADR-010's `user.roles: simple-array`:

- `role(id, name UNIQUE, description?, …)`
- `permission(id, code UNIQUE, description?, …)`
- `role_permissions(role_id, permission_id)` with composite PK and
  `ON DELETE CASCADE` on both FKs.

A fourth join, `staff_user_roles(staff_user_id, role_id)`, lands in
task-02 alongside the `staff_user` rename.

The four canonical role names are `admin`, `catalog-manager`,
`warehouse-staff`, and `order-support`. The 12-code permission registry
(see
[`02-role-and-permission-relational-model.md`](../implementation/epic-01-baseline-identity-staffuser-customer-rbac/02-role-and-permission-relational-model.md)
§3 for the canonical list) lives in `libs/contracts/auth/permission.enum.ts`
as `PermissionCodeEnum`. The enum is the single source of truth —
seeds, the future `@RequiresPermission` decorator, and the future
admin-tooling validator all read it.

This is the direct reversal of ADR-010's Consequences line "no further
indirection is warranted today". The runtime-mutability requirement (§3
of the Context) and the role/permission separation (§2 of the Context)
both require the relational shape.

The schema and the seeded rows land in **task-01**; the StaffUser-side
join lands in **task-02**.

### 3. Three-guard composition + `@RequiresPermission` decorator

ADR-010 §5 committed to a two-guard pipeline
(`JwtAuthGuard → RolesGuard`). This ADR extends that to three:

```
JwtAuthGuard → RolesGuard → PermissionsGuard
```

- `JwtAuthGuard` (unchanged from ADR-010) — proves the bearer token is
  valid, populates `request.user`.
- `RolesGuard` (unchanged surface) — checks `@Roles(RoleEnum.X, …)`
  against `request.user.roles`. Remains the coarse role-bundle gate.
- `PermissionsGuard` (new) — checks `@RequiresPermission(<code>)` against
  `request.user.permissions: string[]`, the array inflated into the
  access JWT at login (see §3 above).

`@RequiresPermission(<PermissionCodeEnum>)` is the default for new
endpoints. `@Roles(<RoleEnum>)` remains available but is reserved for
the cases where the *role* itself is the abstraction the endpoint cares
about (e.g. "any admin" — coarse) rather than a specific capability
(e.g. "may publish a catalog item" — fine). When in doubt, use the
permission decorator.

The inflation happens in `LoginUseCase` and `RefreshTokenUseCase`
(task-03): the use case loads the `StaffUser`'s roles, unions their
`permissions` sets via `IRoleRepositoryPort.findAllByNames(...)`, and
emits the resulting `string[]` as the `permissions` claim on the access
JWT. Guards then read the claim from `request.user` without a per-request
DB hit; the JWT TTL is the staleness window for permission changes.

The decorator and guard land in **task-04**.

### 4. Customer-side public registration (`POST /auth/customer/register`)

ADR-010 §7 deferred public registration until three safeguards exist:
rate-limiting, email verification, and CAPTCHA. This ADR records the
decision to ship the endpoint in epic-01 without all three.

The endpoint:

- Lives at `POST /auth/customer/register`, annotated `@Public()`.
- Returns a customer-tier access + refresh token pair on success (the
  same shape `/auth/login` returns).
- Creates a `Customer` aggregate, not a `StaffUser` — there is no path
  from public register to a staff role.

**Safeguards that land in-epic:** to be confirmed by the task-05
implementer. The strict floor is one of the three (rate-limiting being
the cheapest and most defensible). The other two become "known gap"
follow-ups recorded against the task.

**Trade-off accepted.** Without all three safeguards in place, the
endpoint is vulnerable to (a) credential-stuffing-style enumeration via
the duplicate-email error path, (b) bulk fake-account creation
(spammers, scraper farms), and (c) email-deliverability attacks
(typosquat addresses pinning real users). Mitigations:

- The duplicate-email response is a generic `409 Conflict` with no body
  detail, narrowing (a).
- The known-gap items are tracked against epic-01 as follow-up work, not
  silently deferred to "someday" — naming a deferred safeguard as a
  known gap is itself an architectural decision and belongs here rather
  than buried in a task body.

The endpoint and the known-gap register land in **task-05**.

## Alternatives Considered

### Aggregate split

- **Single `User` with `kind: 'staff' | 'customer'` discriminator.**
  Rejected. Each branch grows independent invariants (staff has
  `status`, customer has order tombstones); the `kind` switch ends up in
  every use case. The split is structural, not cosmetic.

### Permission model

- **Keep `simple-array` and add a second `simple-array` for permissions
  on `user`.** Rejected. Doubles the runtime-mutability problem and makes
  per-role permission-set sharing impossible (every user's permission
  array is independent).
- **Single `permissions: simple-array` column without a role concept.**
  Rejected. Loses the role-bundle abstraction; assigning a job title to
  a new staff member would mean enumerating every code in the
  controller.

### Guard composition

- **Two guards, with `@Roles()` accepting a `RoleEnum | PermissionCodeEnum`
  union.** Rejected. Conflates the two questions ("what role" vs. "what
  capability") at the decorator surface; the union type bleeds into
  every guard signature. The three-guard composition keeps each decorator
  honest.
- **One mega-`AuthzGuard` that reads both `roles` and `permissions`.**
  Rejected. Loses the per-route opt-in / opt-out granularity — every
  route would pay the permission-check cost even when it only needed a
  role check (or vice versa).

### Public registration

- **Hold the endpoint until all three safeguards land.** Rejected. The
  whole point of epic-01 is to ship a working customer-side path; the
  known-gap-with-mitigation shape is the right trade-off given the
  project's portfolio-scope risk profile.

## Consequences

- The `simple-array` `user.roles` column is dropped in task-02 and
  never re-introduced. The `RoleVO` value object stays through task-01
  for backwards-compat with the surviving `User` aggregate, then is
  replaced by `RoleAggregate` in task-02.
- `RoleEnum` in `libs/contracts/auth/role.enum.ts` is demoted from
  "authorization source of truth" to "typed registry of seeded role
  names". The runtime-of-record is the `role` table; the enum is the
  TypeScript view of the four names the seed installs.
- JWT payload size grows by the `permissions: string[]` claim — bounded
  by the 12-code registry plus headroom (~150 bytes worst case). The
  refresh JWT does **not** carry the claim; only access tokens do.
- Permission changes (admin grants `iam:role-edit` to `catalog-manager`)
  take effect on the user's next refresh, not immediately. This is the
  standard JWT-inflation trade-off; the JWT TTL is the staleness window.
- The IAM admin controller (task-06) becomes the single mutation path
  for `role_permissions`. Direct SQL surgery is no longer the expected
  workflow for an operator.
- The four canonical role names are not enforced as an enum at the DB
  layer — admin tooling may introduce a fifth (`returns-clerk`, say) at
  runtime. The seeded four are the floor, not the ceiling.
- ADR-010 §4 / §5 / §7 and the closing `RoleEnum` Consequences
  discussion are superseded by this ADR. Per [ADR-003](003-record-architecture-decisions.md)
  immutability, ADR-010's `**Status**` line carries a one-line forward
  pointer to this ADR; the rest of ADR-010's body remains the
  historical record.

## References

- [ADR-003: Record architecture decisions](003-record-architecture-decisions.md) — supersession rules.
- [ADR-010: JWT authentication and RBAC at the API gateway](010-jwt-rbac-at-the-gateway.md) — the model this ADR supersedes.
- [Implementation doc 02: Role + Permission relational model](../implementation/epic-01-baseline-identity-staffuser-customer-rbac/02-role-and-permission-relational-model.md) — task-01's concrete schema and seed rationale.

## Task chain that lands each decision

- **task-01** → relational `role` / `permission` / `role_permissions` schema, `PermissionCodeEnum`, `RoleAggregate` / `PermissionAggregate`, seeded 12 codes + 4 roles (this PR).
- **task-02** → `user` → `staff_user` rename, `staff_user_roles` join, drop of the `simple-array` `roles` column, `StaffUser` aggregate replacing `User`.
- **task-03** → JWT `permissions: string[]` inflation in `LoginUseCase` / `RefreshTokenUseCase`.
- **task-04** → `PermissionsGuard` + `@RequiresPermission(<code>)` decorator wired into the global guard chain.
- **task-05** → `Customer` aggregate + `POST /auth/customer/register` (`@Public()`) + known-gap register for deferred safeguards.
- **task-06** → IAM admin controller (`@RequiresPermission('iam:role-edit')`) for runtime `role_permissions` mutation.
