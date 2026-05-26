---
epic: epic-01
task_number: 10
title: Documentation pass — README.md + CLAUDE.md updates + architecture-lint fixture extension
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06, task-07, task-08, task-09]
doc_deliverable: none
---

# Task 10 — Documentation pass (`README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts`)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Land the public-facing documentation surface for what epic-01 changed. Three artifacts:

1. **`README.md`** — replace the now-outdated User/Roles narrative with the relational RBAC model; update the seed-users table; surface the new routes.
2. **`CLAUDE.md`** — refresh the `modules/auth` listing and add an "Authentication conventions" bullet describing when to use `@RequiresPermission()` vs `@Roles()`.
3. **`spec/architecture-lint.spec.ts`** — extend the fixture set so the new files (`customer.entity.ts`, `role.entity.ts`, `permission.entity.ts`, the iam module's domain/application/infrastructure/presentation tree) pass the boundary checks, and add at least one *negative* fixture per new layer so a future regression is caught.

This task is purely documentation + lint hygiene; no production code changes.

## Entry state assumed

Tasks 1–9 complete. Every entity, controller, doc, .http file, and seed extension exists at the paths the prior tasks specified.

## Scope

**In:**

- `README.md` revisions per the epic's `Documentation Deliverables → README.md updates required`.
- `CLAUDE.md` revisions per the epic's `Documentation Deliverables → CLAUDE.md updates required`.
- Extending `spec/architecture-lint.spec.ts` with positive + negative fixtures for the new module shape.
- A final pass to grep for and remove any accidental references to `tmp/` in non-tmp files.

**Out:**

- New ADRs. The epic-01 changes fit inside ADRs 004, 010, 017, 019; no new ADR is required (per the epic, "Exclusions Register documents owned by this epic: None").
- Changes to the `docs/implementation/.../*.md` files written by tasks 1–7 — those are signed-off in their respective tasks.

## `README.md` — concrete edits

Find the **System diagram** "API Gateway port: 3000" block. Replace the route list with the full epic-01 set:

- `/auth/staff/login`, `/auth/login` (deprecated alias), `/auth/refresh`, `/auth/logout`, `/auth/me`, `/auth/admin/ping`
- `/auth/customer/register`, `/auth/customer/login`, `/auth/customer/me`
- `/iam/roles` (GET/POST), `/iam/roles/:id` (PATCH), `/iam/staff/:id/roles` (POST), `/iam/staff/:id/roles/:roleName` (DELETE)

Find the **Authentication → Roles** subsection. Replace the existing narrative with:

1. A short paragraph explaining the relational model: `role` and `permission` tables, `role_permissions` and `staff_user_roles` join tables, the source-of-truth permission codes in `libs/contracts/auth/permission.enum.ts`.
2. A markdown table:

   | Role | Permission codes |
   | --- | --- |
   | `admin` | every code |
   | `catalog-manager` | `catalog:read`, `catalog:write`, `catalog:publish` |
   | `warehouse-staff` | `inventory:read`, `inventory:adjust`, `inventory:transfer` |
   | `order-support` | `order:read`, `order:cancel`, `order:refund` |

3. A `@RequiresPermission()` snippet showing the new gating pattern, with a one-sentence note on how it interacts with `@Roles()` (links to `docs/implementation/epic-01-…/03-permissions-guard-and-decorator.md`).

Add a new **Permissions** subsection under **Authentication** listing every seeded permission code and the role bundles it appears in. Use the codes from `libs/contracts/auth/permission.enum.ts` as the authoritative list.

Replace the **Local development → Seed users** table with the new set (task-09):

| Email | Password | Role | Type |
| --- | --- | --- | --- |
| `admin@example.com` | `admin1234` | `admin` | StaffUser |
| `catalog@example.com` | `catalog1234` | `catalog-manager` | StaffUser |
| `warehouse@example.com` | `warehouse1234` | `warehouse-staff` | StaffUser |
| `support@example.com` | `support1234` | `order-support` | StaffUser |
| `customer@example.com` | `customer1234` | — | Customer |

## `CLAUDE.md` — concrete edits

Find **Service Structure → API Gateway → modules/auth** (or the equivalent header). Replace the User aggregate description with:

- **StaffUser** — `apps/api-gateway/src/modules/auth/domain/staff-user.model.ts`. Soft-delete via `status`; bound to `RoleAggregate[]`.
- **Customer** — `apps/api-gateway/src/modules/auth/domain/customer.model.ts`. Buyer-side identity; tombstone-friendly (every PII column nullable).
- **RoleAggregate** + **PermissionAggregate** — `apps/api-gateway/src/modules/auth/domain/{role,permission}.aggregate.ts`. Relational, runtime-mutable via the IAM admin controller.

Update the file-listing snippet under `modules/auth/` to reflect the new tree. Add a sibling bullet for `modules/iam/` describing the admin controller and use cases.

Add a new bullet under an **Authentication conventions (gateway)** sub-header (create it if it doesn't exist):

> `@RequiresPermission(<code>)` is the precise gate for any new endpoint — it checks `request.user.permissions` (populated by JWT inflation in `LoginUseCase` / `RefreshTokenUseCase`). `@Roles(<RoleEnum>)` remains valid for coarse role-bundle gating where the precise permission isn't meaningful (rare; defaults are to use `@RequiresPermission`).

If the existing **Authentication** section mentions `roles: simple-array` or the old single `user` table, delete those lines.

## `spec/architecture-lint.spec.ts` — extensions

Extend the existing fixture set with new positive and negative cases for the new files. The current spec covers per-layer external denials (e.g., "domain may not import `typeorm`") with fixture paths under `apps/inventory-microservice/src/modules/stock/`. Mirror that style with paths under the new layout:

- `apps/api-gateway/src/modules/auth/domain/__fixture__.ts` — verify a `Role` aggregate cannot import from `@retail-inventory-system/messaging` or `typeorm`. (Negative.)
- `apps/api-gateway/src/modules/auth/application/use-cases/__fixture__.ts` — verify it cannot import `typeorm` or `@nestjs/typeorm`. (Negative.)
- `apps/api-gateway/src/modules/iam/application/use-cases/__fixture__.ts` — same negative.
- `apps/api-gateway/src/modules/iam/presentation/__fixture__.ts` — verify it cannot import infrastructure. (Negative.)
- `apps/api-gateway/src/modules/auth/infrastructure/audit/__fixture__.ts` — positive: it may import `@retail-inventory-system/contracts` (for the port interface). The new `boundaries/dependencies` machinery treats this as in-element-type `infrastructure`, so reuse the existing infrastructure allow-rule.

Important caveats:

- The architecture-lint spec uses real production-file paths as the *target* of the cross-element negative fixtures. Make sure the production files referenced by each new negative fixture actually exist at the imported path — otherwise the resolver returns `unknown` and the test asserts the wrong thing. After writing the fixtures, run `yarn jest spec/architecture-lint.spec.ts` and confirm every new assertion produces a `boundaries/dependencies` rule-id.
- Do **not** modify `eslint.config.mjs` or the element-type definitions inside the spec — the new files all fit existing element types (`domain`, `application-use-case`, `infrastructure`, `presentation`).

## Final `tmp/` hygiene pass

Grep across `docs/`, `apps/`, `libs/`, `http/`, `README.md`, `CLAUDE.md`, `scripts/`, `spec/` for the string `tmp/` and fix or delete any references. The epic explicitly forbids them ("No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`").

```bash
grep -rn "tmp/" docs/ apps/ libs/ http/ README.md CLAUDE.md scripts/ spec/ 2>/dev/null
```

Expected output: empty.

## Files to add

None.

## Files to modify

- `README.md`.
- `CLAUDE.md`.
- `spec/architecture-lint.spec.ts`.

## Files to delete

None (unless the `tmp/` grep above finds stale references in source files — delete them in place).

## Tests

- `yarn jest spec/architecture-lint.spec.ts` — passes with the new fixtures.
- Full `yarn lint && yarn test:unit && yarn test:e2e` from a fresh `yarn migration:run && yarn seed` — every gate green.
- The full epic-01 exit criteria (see the README at the top of this task folder) are met.

## Doc deliverable

None. The doc folder `docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/` is already complete by task-08; this task adjusts the project-level docs only.

## Carryover produced

- `README.md` reflects the relational RBAC model + the new route list + the new seed set.
- `CLAUDE.md` references the new module shape + the `@RequiresPermission` convention.
- `spec/architecture-lint.spec.ts` covers the new module tree with at least one positive + one negative fixture per new layer.
- Zero `tmp/` references in any non-tmp file.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes — the extended `architecture-lint.spec.ts` is green.
- [ ] `yarn test:e2e` passes end-to-end on a fresh seed.
- [ ] `README.md`'s Authentication section mentions `@RequiresPermission`, lists the 12 permission codes, and shows the four-role binding table.
- [ ] `CLAUDE.md` no longer references the `User` aggregate or the `roles: simple-array` column.
- [ ] `grep -rn "tmp/" docs/ apps/ libs/ http/ README.md CLAUDE.md scripts/ spec/` returns no matches.
- [ ] The cumulative `Exit criteria` block in `tmp/tasks/epic-01-…/README.md` is fully satisfied.
