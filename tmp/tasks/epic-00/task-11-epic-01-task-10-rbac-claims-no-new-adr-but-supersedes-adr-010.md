---
epic: epic-00
task_number: 11
title: Fix `epic-01/task-10` "no new ADR is required" claim — epic-01 substantively supersedes ADR-010
depends_on: []
doc_deliverable: null
---

# Task 11 — `epic-01/task-10` claims "no new ADR is required" but epic-01 supersedes ADR-010's RBAC model

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-010 (§4 "User aggregate lives in the gateway", §5 "All routes protected by default", §7 "Public registration is deferred", and the Consequences block on `RoleEnum`), ADR-003 (record-architecture-decisions cadence — "When making an architectural decision, write an ADR"), and the in-flight `tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/` task set (especially task-01, task-02, task-04, task-05, task-10) in full before editing. CLAUDE.md §"API Gateway" describes the live two-guard composition (`JwtAuthGuard` + `RolesGuard`) that epic-01 task-04 grows to three.

## ADR audited

[ADR-010 — JWT authentication and RBAC at the API gateway](../../../docs/adr/010-jwt-rbac-at-the-gateway.md). Accepted (2026-05-10).

## Contradiction

`tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-10-documentation-pass-readme-claudemd-arch-lint.md:41` declares, under §"Out":

> **New ADRs.** The epic-01 changes fit inside ADRs 004, 010, 017, 019; no new ADR is required (per the epic, "Exclusions Register documents owned by this epic: None").

This instruction contradicts the binding rules and decision text of ADR-010 in four distinct ways. The cumulative epic-01 design is not a refinement of ADR-010 — it is a substantive replacement of ADR-010's RBAC and identity model, and Per ADR-003 ("When making an architectural decision, write an ADR"), an architectural change of this size needs its own ADR (or an explicit amendment chain on ADR-010 carrying forward-supersession pointers).

Surface: `tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-10-documentation-pass-readme-claudemd-arch-lint.md:41` (the explicit "no new ADR is required" declaration) and the in-flight task set it depends on (epic-01 task-01, task-02, task-03, task-04, task-05).

## Evidence

### (1) ADR-010 §5 fixes the global-guard composition at two guards; epic-01 task-04 adds a third.

ADR-010 §5 "All routes protected by default" (`docs/adr/010-jwt-rbac-at-the-gateway.md:99-117`):

```text
**Chosen.** `JwtAuthGuard` and `RolesGuard` are registered as global
`APP_GUARD` providers in `apps/api-gateway/src/app/app.module.ts`. Every
route is bearer-token-required unless the handler or controller carries
`@Public()` from `@retail-inventory-system/auth`.
```

Live code (`apps/api-gateway/src/app/app.module.ts:25-28`):

```ts
providers: [
  { provide: APP_GUARD, useClass: JwtAuthGuard },
  { provide: APP_GUARD, useClass: RolesGuard },
],
```

`tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-04-permissions-guard-and-requires-permission-decorator.md:115,156`:

```text
`apps/api-gateway/src/app/app.module.ts` — extend imports to include `PermissionsGuard` from `@retail-inventory-system/auth`; append `{ provide: APP_GUARD, useClass: PermissionsGuard }` **after** the existing `RolesGuard` provider. Verify the order in the file matches: `JwtAuthGuard` → `RolesGuard` → `PermissionsGuard`.
…
[ ] `apps/api-gateway/src/app/app.module.ts` registers exactly three `APP_GUARD` providers in the order `JwtAuthGuard`, `RolesGuard`, `PermissionsGuard`.
```

ADR-010 §5 commits the gateway to a 2-guard pipeline; task-04 grows it to 3. This is an architectural change to the request-authorization model — same surface, same composition site, but a different number of stages with different semantics (`@RequiresPermission` is not a `@Roles` refinement; it reads `request.user.permissions`, a new claim epic-01 inflates per task-03).

### (2) ADR-010 §4 has a unitary `User` aggregate; epic-01 task-02 + task-05 split it into `StaffUser` + `Customer`.

ADR-010 §4 "The `User` aggregate lives in the gateway" (`docs/adr/010-jwt-rbac-at-the-gateway.md:83-97`):

```text
**Chosen.** `apps/api-gateway/src/modules/auth/` owns `User`. The gateway
gains a TypeORM connection (`DatabaseModule.forRoot([UserEntity])`).
…
**Rejected: `User` lives in `retail-microservice` next to `customer`.** The
`customer` row in retail represents a buyer, not an authenticated principal:
a future "store manager" admin may have no `customer` row and still need to
log in. Coupling the two now would force a refactor later.
```

ADR-010 explicitly anticipates a *future* split (a "future store manager admin") but commits **today** to a unitary `User`. Epic-01 ships that split:

`tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-02-rename-user-to-staff-user-and-drop-simple-array-roles.md:18,77`:

```text
Convert the `User` aggregate into `StaffUser` and the `user` table into `staff_user`. Drop the `roles: simple-array` column and replace it with a relational `staff_user_roles` join…
…
`apps/api-gateway/src/modules/auth/application/ports/user.repository.port.ts` → **rename file to** `staff-user.repository.port.ts`. `IUserRepositoryPort` → `IStaffUserRepositoryPort`, `USER_REPOSITORY` → `STAFF_USER_REPOSITORY`, `User` → `StaffUser`.
```

`tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-05-customer-table-and-customer-auth-endpoints.md:36-43`:

```text
- New `customer` table per the epic's "In-Scope Entities" specification.
- New `Customer` domain aggregate (separate from `StaffUser`).
…
- An `IAuthUserValidator` that distinguishes staff vs. customer subjects so `JwtStrategy` can route a customer JWT to the customer repo.
```

The unitary `User` aggregate ADR-010 §4 endorsed is gone after task-05. Two aggregates exist, with different lifecycles (`StaffUser` carries roles + permissions; `Customer` does not), different login routes (`/auth/staff/login` vs. `/auth/customer/login`), and different JWT inflation rules. ADR-010 §4's rationale ("a future store manager admin may have no `customer` row…") survives in spirit but is no longer the *implementation* — the implementation is one cycle ahead of the ADR.

### (3) ADR-010 Consequences fixes `RoleEnum` at `'admin' | 'customer'` and a three-file role-edit; epic-01 task-01 + task-02 introduce a relational role/permission/role_permissions/staff_user_roles schema and four seeded roles.

ADR-010 §Consequences (`docs/adr/010-jwt-rbac-at-the-gateway.md:164-167`):

```text
- The RoleEnum value is `'admin' | 'customer'`. Adding a new role is a
  three-file edit (`libs/contracts/auth/role.enum.ts`, the seed, the route's
  `@Roles(...)` annotation) — small enough that no further indirection is
  warranted today.
```

Live code (`libs/contracts/auth/role.enum.ts`):

```ts
export enum RoleEnum {
  ADMIN = 'admin',
  CUSTOMER = 'customer',
}
```

`tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-01-add-role-permission-tables-and-seed-registry.md:18,36`:

```text
Introduce the relational RBAC schema (tables `role`, `permission`, `role_permissions`) and the single source of truth for permission codes (`libs/contracts/auth/permission.enum.ts`).
…
- New domain aggregates `RoleAggregate`, `PermissionAggregate` (these are different files from the existing `RoleVO` — they do **not** replace it yet).
```

`tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-05-customer-table-and-customer-auth-endpoints.md:30`:

```text
- `RoleEnum` has no `CUSTOMER` value (removed in task-02).
```

`tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-06-iam-admin-controller.md:27`:

```text
- `RoleEnum` is the typed registry of the four canonical names (admin / catalog-manager / warehouse-staff / order-support).
```

The "no further indirection is warranted today" rationale of ADR-010 Consequences is the exact decision that task-01 reverses — it adds the indirection (relational tables, `RoleAggregate`, `PermissionAggregate`, a `staff_user_roles` join), and task-06 adds a runtime mutation surface for it (an IAM admin controller). This is the canonical kind of decision that ADR-003 says **must** be recorded as an ADR.

### (4) ADR-010 §7 defers public registration until rate-limiting + email-verification + CAPTCHA exist; epic-01 task-05 ships customer-side public register without any of those.

ADR-010 §7 "Public registration is deferred" (`docs/adr/010-jwt-rbac-at-the-gateway.md:135-141`):

```text
`RegisterUserUseCase` exists and is unit-tested, but is **not** exposed via
HTTP. Seed users (`admin@example.com` / `customer@example.com`) cover every
test scenario today; the live registration flow needs rate limiting, email
verification, and CAPTCHA before it can be safe to expose, none of which is
in scope. Deferred as a follow-up.
```

`tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-05-customer-table-and-customer-auth-endpoints.md:53,92,130,132`:

```text
- Email verification flow (`email_verified_at` is just a column; the flow comes later).
…
`@Controller('auth/customer')`, mounts `POST /register`, `POST /login`, `GET /me`. `@Public()` on register + login;
…
3. **Registration semantics.** A `Customer` row is created in `status='active'` with `email_verified_at: null`. No email verification flow yet (deferred). Password hashed with the same `Argon2PasswordAdapter` as staff.
…
5. **Permission to gate customer reads.** Customer endpoints under `/api/auth/customer/*` are either `@Public()` (register, login) or `@CurrentUser()`-only (me).
```

Task-05 exposes `POST /auth/customer/register` as `@Public()`, without rate-limiting, without email verification, and without CAPTCHA. ADR-010 §7 named those three concerns specifically; task-05 satisfies none of them. Whether the right answer is "build the safeguards" or "ship register-without-safeguards and accept the trade-off" is itself an architectural decision that warrants its own ADR — the gap is precisely what ADR-010 §7 said needed an explicit decision before exposing the surface.

### (5) Task-10 itself acknowledges the scope of the change.

`tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-10-documentation-pass-readme-claudemd-arch-lint.md:78-86,92`:

```text
Find **Service Structure → API Gateway → modules/auth** (or the equivalent header). Replace the User aggregate description with:

- **StaffUser** — `apps/api-gateway/src/modules/auth/domain/staff-user.model.ts`. Soft-delete via `status`; bound to `RoleAggregate[]`.
- **Customer** — `apps/api-gateway/src/modules/auth/domain/customer.model.ts`. Buyer-side identity; tombstone-friendly (every PII column nullable).
- **RoleAggregate** + **PermissionAggregate** — `apps/api-gateway/src/modules/auth/domain/{role,permission}.aggregate.ts`. Relational, runtime-mutable via the IAM admin controller.

Update the file-listing snippet under `modules/auth/` to reflect the new tree. Add a sibling bullet for `modules/iam/` describing the admin controller and use cases.
…
If the existing **Authentication** section mentions `roles: simple-array` or the old single `user` table, delete those lines.
```

The same task that says "no new ADR is required" simultaneously updates CLAUDE.md to delete every reference to ADR-010's chosen design (`User` aggregate, `roles: simple-array` column, single `user` table) and replace them with the new design. CLAUDE.md is downstream of the ADR set, not a substitute for it — if CLAUDE.md needs a rewrite of this size, the ADR set needs a corresponding entry. Updating CLAUDE.md without filing an ADR breaks the ADR-003 cadence and leaves a future reader of `docs/adr/` with a stale picture of the architecture.

## Why this matters

ADR-003 §"Why this matters" (and its derivative working agreements in CLAUDE.md "Architecture rules location") promise that `docs/adr/` is the durable record of architectural decisions. If a single task (`task-10`) declares no new ADR is needed despite an epic that replaces ADR-010's authentication model with a different one, three things break:

1. **The ADR set drifts silently.** A future contributor reading `docs/adr/010-jwt-rbac-at-the-gateway.md` learns about a unitary `User`, a 2-element `RoleEnum`, and a 2-guard pipeline that no longer exists. ADR-010 has no forward pointer to where those decisions were superseded.
2. **The "this fits inside ADR-010" claim mis-leads code review.** Reviewers expect the diff to look like a refinement of ADR-010's surface — extending the existing two-element `RoleEnum`, adding a route to the existing `User` aggregate, etc. They get a relational RBAC schema, an aggregate split, and a new global guard. The mismatch makes architectural review harder, not easier.
3. **The precedent erodes ADR-003.** If "no new ADR is required" is acceptable here, the same template applies to every future epic. The audit-2026-05-08 → ADR-016/021/022/023 sequence (where each cache-aside generalization got its own forward-supersession ADR) is the project's example of how this should be handled.

The same supersession-pointer pattern is already filed for ADR-001 (epic-00/task-01), ADR-002 (epic-00/task-02), ADR-006 (epic-00/task-05), and ADR-012 (epic-00/task-12, filed in this same session). Epic-01's RBAC v2 design deserves either a new ADR (preferred) or a forward-supersession amendment on ADR-010.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — File a new ADR for "RBAC v2: StaffUser/Customer split + relational role/permission model + PermissionsGuard" and rewrite `epic-01/task-10:41` to require it (recommended).**

The new ADR's surface:

- Status: Accepted (supersedes ADR-010 §4, §5, §7, and the Consequences `RoleEnum` discussion).
- Decision text covers, at minimum: (a) split `User` → `StaffUser` + `Customer` and the rationale (anticipated in ADR-010 §4); (b) `staff_user_roles` + `role_permissions` relational schema + `RoleAggregate`/`PermissionAggregate`; (c) `@RequiresPermission(<code>)` as the precise gate, `@Roles(<RoleEnum>)` as the coarse gate, and the three-guard `JwtAuthGuard → RolesGuard → PermissionsGuard` composition; (d) the customer-side public register decision and how it relates to ADR-010 §7's deferred rate-limiting/email-verification/CAPTCHA concerns (the ADR documents whether those safeguards land in-epic, are deferred again, or are explicitly accepted as a known gap).
- Add a forward-supersession pointer on ADR-010's `**Status**` line per the ADR-003-permitted line edit: `**Status**: Accepted (RBAC model superseded by [ADR-NNN](NNN-rbac-v2-staffuser-customer-and-permissions.md))`. Do not rewrite the historical decision text; the ADR is the historical record.
- `task-10` of epic-01 is rewritten to (i) drop the line 41 declaration that no new ADR is required, (ii) reference the new ADR as a deliverable owned by **task-01** (the foundational task) or the new ADR is filed as a separate task in epic-01 itself.

**Option B — Add forward-supersession pointers from ADR-010 to the four most-impacted epic-01 sections, without filing a new ADR.**

ADR-003 §"Status flips" permits status updates and one-line forward pointers. In principle, ADR-010 could carry four such pointers (one per affected section) into a single "amendment epic" that piggy-backs on epic-01. Rejected as the recommendation because: (a) the RBAC v2 design has its own internal logic (the `@RequiresPermission` decorator interacts with JWT inflation in `LoginUseCase`/`RefreshTokenUseCase` — that's a decision worth recording in one place, not scattered as forward pointers); (b) the customer-register deferred-safeguards decision is genuinely new and has no analog in ADR-010 to forward-point from; (c) the existing project precedent (ADR-016/021/022/023 superseding ADR-002/006) is one-ADR-per-substantive-change, not one-pointer-per-section.

If option B is chosen anyway, the implementer must at minimum (a) cite ADR-010 in epic-01 task-10 explicitly with the four superseded sections enumerated, (b) replace the line 41 declaration with the four pointers, and (c) flag the customer-register deferred-safeguards decision as either in-scope-without-ADR (and accept the regression of ADR-003 cadence) or out-of-scope-of-epic-01.

## Scope

**In:**

- Edit `tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-10-documentation-pass-readme-claudemd-arch-lint.md` to drop the line 41 declaration that no new ADR is required, and to reference the new ADR.
- Optionally edit `tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-01-add-role-permission-tables-and-seed-registry.md` to add a `Doc deliverable` slot for the new ADR (or split the ADR file into its own epic-01 task — implementer's call).
- Optionally edit the epic-01 README to mention the new ADR in the deliverables table.

**Out:**

- Any change to live production code in `apps/` or `libs/`.
- Any change to ADR-010 beyond the one-line forward-supersession `**Status**` pointer (per ADR-003 immutability).
- Filing the new ADR itself — that is the deliverable of an epic-01 task, not this epic-00 correction task. This task's job is to remove the contradiction; the ADR file follows from it.

## Exit criteria

- [ ] `tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-10-documentation-pass-readme-claudemd-arch-lint.md` no longer declares "no new ADR is required". The line is replaced with a reference to the new ADR (option A) or to the four forward pointers (option B).
- [ ] If option A is chosen, the new ADR is named in an epic-01 task's `Doc deliverable` slot.
- [ ] `yarn lint` still passes (this task edits only `tmp/tasks/**/*.md`).
- [ ] `tmp/adr-verification-progress.md` ADR-010 row reflects this task's findings.
