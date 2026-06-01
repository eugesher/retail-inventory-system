---
epic: epic-01
source_epic_file: tmp/epics/epic-01-baseline-identity-staffuser-customer-rbac.md
---

# Epic 01 — Task Index

Decomposition of `tmp/epics/epic-01-baseline-identity-staffuser-customer-rbac.md` into 10 sequential, self-contained execution tasks. Each task file is meant to be picked up by a single execution session: it states its entry-state assumption (what previous tasks left on disk), the concrete files to add/modify/delete, the doc deliverable, and the exit criteria.

## Sequence and dependencies

Each task depends on every task before it via the `Carryover Between Tasks` table in the epic. Do them in order; do not parallelize.

| #   | Task                                                                | Touches                                                | Doc deliverable                                                       |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 01  | [Add `role` + `permission` tables and seed registry](task-01-add-role-permission-tables-and-seed-registry.md) | `libs/contracts/auth/`, `auth/domain/`, `auth/infrastructure/persistence/`, `migrations/`, `scripts/test-db-seed.ts`, **`docs/adr/`** | `02-role-and-permission-relational-model.md` **+ new ADR `NNN-rbac-v2-staffuser-customer-and-permissions.md` (supersedes ADR-010's RBAC model)** |
| 02  | [Rename `user` → `staff_user`, drop `simple-array` roles, add `staff_user_roles`](task-02-rename-user-to-staff-user-and-drop-simple-array-roles.md) | `auth/domain/`, `auth/infrastructure/persistence/`, `auth/application/ports/`, `migrations/`, `apps/api-gateway/src/app/app.module.ts`, all auth use-case import sites | `01-staffuser-customer-split.md` (staff half) |
| 03  | [Inflate JWT permissions claim on login + refresh](task-03-inflate-jwt-permissions-claim-on-login.md) | `libs/contracts/auth/jwt-payload.dto.ts`, `libs/contracts/auth/current-user.dto.ts`, `libs/auth/jwt.strategy.ts`, login/refresh use cases, `ValidateUserUseCase`, related specs | `03-permissions-guard-and-decorator.md` (inflation half) |
| 04  | [Add `PermissionsGuard` + `@RequiresPermission()` and re-gate `/auth/admin/ping`](task-04-permissions-guard-and-requires-permission-decorator.md) | `libs/auth/permissions.guard.ts`, `libs/auth/requires-permission.decorator.ts`, `libs/auth/index.ts`, `apps/api-gateway/src/app/app.module.ts`, `auth-admin.controller.ts` | `03-…md` (guard + decorator half) |
| 05  | [Add `customer` table + customer-side register/login/me endpoints](task-05-customer-table-and-customer-auth-endpoints.md) | new `customer` aggregate + entity + repo + use cases + DTOs, new `customer-auth.controller.ts`, migration, `auth.module.ts` registrations | `01-…md` (customer half) + `04-customer-register-and-login.md` |
| 06  | [Add IAM admin controller — roles + role-assignment endpoints](task-06-iam-admin-controller.md) | new `iam/` module under `apps/api-gateway/src/modules/`, IAM use cases, DTOs, controller | `05-iam-admin-endpoints.md` |
| 07  | [Introduce `AUDIT_LOG_PUBLISHER` port + no-op default adapter](task-07-audit-log-publisher-port-skeleton.md) | `libs/contracts/auth/audit-log-publisher.port.ts`, `auth/infrastructure/audit/no-op-audit-log.publisher.ts`, call-site additions in auth + IAM use cases | `06-audit-log-publisher-port-skeleton.md` |
| 08  | [Author `http/auth.http` and `http/iam.http`](task-08-kulala-auth-and-iam-http-files.md) | `http/auth.http`, `http/iam.http` | `07-kulala-auth-and-iam-files.md` |
| 09  | [Extend `scripts/test-db-seed.ts` with the full seed set](task-09-extend-test-db-seed.md) | `scripts/test-db-seed.ts` (4 staff users + 1 customer + role bindings) | — |
| 10  | [Documentation pass — README, CLAUDE.md, arch-lint fixtures](task-10-documentation-pass-readme-claudemd-arch-lint.md) | `README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts` | — |

## Document-deliverable map

The epic's `Documentation Deliverables` lists seven topic-numbered docs. Several docs are written by more than one task:

- **`01-staffuser-customer-split.md`** — task-02 writes the staff half (User → StaffUser rename, soft-delete + status column rationale). Task-05 appends the customer half (why Customer is a separate aggregate, Q7 guest-row shape, Q6 tombstone-friendly nullability).
- **`02-role-and-permission-relational-model.md`** — task-01 writes the entire doc in one shot (it's the rationale doc for the tables added in task-01).
- **`03-permissions-guard-and-decorator.md`** — task-03 writes the JWT inflation half (roles claim → permissions claim path). Task-04 appends the guard ergonomics + decorator interaction + ordering vs `RolesGuard`.
- **`04-customer-register-and-login.md`** — task-05.
- **`05-iam-admin-endpoints.md`** — task-06.
- **`06-audit-log-publisher-port-skeleton.md`** — task-07.
- **`07-kulala-auth-and-iam-files.md`** — task-08.

In addition, the epic's cumulative architectural decision is recorded as a new ADR (per [epic-00/task-11](../epic-00/task-11-epic-01-task-10-rbac-claims-no-new-adr-but-supersedes-adr-010.md)):

- **`docs/adr/NNN-rbac-v2-staffuser-customer-and-permissions.md`** — owned by task-01. Supersedes ADR-010 §4 (unitary `User`), §5 (two-guard pipeline), §7 (deferred public registration), and the Consequences `RoleEnum` discussion (two-element enum, three-file role-edit rationale). ADR-010 itself receives a one-line forward-supersession pointer on its `**Status**` line; the original body is otherwise untouched (ADR-003 immutability).

## Self-containment rule

> Outputs produced by these tasks must not reference any path under `tmp/`. The task files themselves live in `tmp/tasks/...` and are scaffolding; the artifacts they produce (entities, migrations, docs, controllers, http files) live under `apps/`, `libs/`, `migrations/`, `http/`, `docs/`, `scripts/`, `spec/`, `README.md`, `CLAUDE.md` — and none of those files may cite `tmp/`.

## Exit criteria (all 10 tasks complete)

Mirrors the epic's `Exit Criteria` section. Each task carries its own per-task exit criteria; this is the cumulative gate.

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` and `yarn test:e2e` are green against fresh test infra + seed.
- [ ] `docker compose up -d mysql redis rabbitmq && yarn migration:run && yarn start:dev:api-gateway` boots the gateway with the new tables present.
- [ ] All requests in `http/auth.http` and `http/iam.http` execute end-to-end against the seeded admin user.
- [ ] `GET /api/auth/admin/ping` is gated behind `audit:read`; a StaffUser lacking the permission gets `403`, the seeded admin gets `200`.
- [ ] The old `user.roles` simple-array column is gone (MySQL `DESCRIBE staff_user;` shows no `roles` column).
- [ ] Per-task docs present under `docs/implementation/01-baseline-identity-staffuser-customer-rbac/`.
- [ ] New ADR `docs/adr/NNN-rbac-v2-staffuser-customer-and-permissions.md` present (number allocated at task-01 first commit); `docs/adr/010-jwt-rbac-at-the-gateway.md` `**Status**` line carries the one-line forward-supersession pointer and nothing else has changed in the file; `docs/adr/index.md` lists the new ADR.
- [ ] `README.md` Authentication section reflects the relational RBAC model; `CLAUDE.md` modules/auth listing matches the new file set.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.
