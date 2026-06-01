---
epic: epic-01
task_number: 4
title: Introduce `PermissionsGuard` + `@RequiresPermission()` in `libs/auth/`; wire globally; re-gate `/auth/admin/ping`
depends_on: [task-01, task-02, task-03]
doc_deliverable: docs/implementation/01-baseline-identity-staffuser-customer-rbac/03-permissions-guard-and-decorator.md
---

# Task 04 — `PermissionsGuard` + `@RequiresPermission()` + global wiring

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Make role-bundled atomic permission codes the authoritative gating mechanism. Introduce a third global guard (downstream of `JwtAuthGuard` and `RolesGuard`) that reads `@RequiresPermission(...)` metadata off the handler and intersects it with `request.user.permissions`. Re-gate the existing `/api/auth/admin/ping` smoke endpoint behind `@RequiresPermission('audit:read')` so a non-admin StaffUser hits 403 even if their role passes `RolesGuard`.

This task is the payoff for task-03's inflation work: the guard does **no DB lookup** — it just reads the permission array off `request.user` and matches it against the decorator's metadata.

## Entry state assumed

Task-03 carryover present:

- `request.user` is `ICurrentUser` with `permissions: string[]` populated (for staff JWTs; customer JWTs will have `permissions: []` after task-05).
- `IJwtAccessPayload.permissions` exists and is set on every issued access JWT.
- `libs/auth/` contains `jwt-auth.guard.ts`, `roles.guard.ts`, `roles.decorator.ts`, `public.decorator.ts`, `auth.module.ts`, `index.ts`. `libs/auth/auth.module.ts::forRootAsync` already registers `JwtAuthGuard` + `RolesGuard` as providers and exports them.
- `apps/api-gateway/src/app/app.module.ts` wires `{ provide: APP_GUARD, useClass: JwtAuthGuard }` and `{ provide: APP_GUARD, useClass: RolesGuard }`.
- `apps/api-gateway/src/modules/auth/presentation/auth-admin.controller.ts` gates `/ping` with `@Roles(RoleEnum.ADMIN)` only.

## Scope

**In:**

- New `libs/auth/permissions.guard.ts` and `libs/auth/requires-permission.decorator.ts`.
- Re-export from `libs/auth/index.ts`.
- Register `PermissionsGuard` inside `libs/auth/auth.module.ts::forRootAsync` (so consumers don't have to wire it manually).
- Append a third `{ provide: APP_GUARD, useClass: PermissionsGuard }` in `apps/api-gateway/src/app/app.module.ts` — order matters: must come **after** `RolesGuard`.
- Re-gate `/api/auth/admin/ping` to use `@RequiresPermission(PermissionCodeEnum.AUDIT_READ)`. Keep `@ApiBearerAuth()` and the existing controller-level shape.
- Append the **guard + decorator half** to `docs/implementation/01-baseline-identity-staffuser-customer-rbac/03-permissions-guard-and-decorator.md` (started in task-03; replace the `<!-- guard-and-decorator-half-anchor -->` marker).
- Guard spec: `libs/auth/spec/permissions.guard.spec.ts`.

**Out:**

- Customer-side endpoints — task-05.
- IAM admin endpoints — task-06.
- Any change to `RolesGuard` (it stays for coarse role-bundle gating; `@Roles()` remains valid).

## Guard semantics (concrete)

Decorator:

```ts
// libs/auth/requires-permission.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const REQUIRES_PERMISSION_KEY = 'auth:requires-permission';

export const RequiresPermission = (
  ...permissions: string[]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRES_PERMISSION_KEY, permissions);
```

`@RequiresPermission('catalog:write')` — handler runs only if `request.user.permissions` includes `'catalog:write'`. `@RequiresPermission('catalog:write', 'catalog:publish')` — handler runs if **any** of the listed codes is present (logical OR, mirroring `RolesGuard`'s "hasRole" behaviour). For AND-semantics (rare), apply the decorator twice on different layers or wait for an explicit follow-up — the epic does not require AND-semantics in this iteration.

Guard:

```ts
// libs/auth/permissions.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ICurrentUser } from '@retail-inventory-system/contracts';
import { REQUIRES_PERMISSION_KEY } from './requires-permission.decorator';

interface IRequestWithUser { user?: ICurrentUser }

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRES_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<IRequestWithUser>();
    const userPerms = request.user?.permissions ?? [];
    const ok = required.some((code) => userPerms.includes(code));
    if (!ok) throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}
```

Guard ordering: `JwtAuthGuard` (auth) → `RolesGuard` (role) → `PermissionsGuard` (permission). The composition is honoured by Nest's `APP_GUARD` provider ordering — guards run in registration order, and any one returning `false` / throwing terminates the chain. Document this ordering in the doc deliverable.

## Files to add

- `libs/auth/permissions.guard.ts` — body above.
- `libs/auth/requires-permission.decorator.ts` — body above.
- `libs/auth/spec/permissions.guard.spec.ts` — cases:
  - No `@RequiresPermission()` metadata → allows.
  - Metadata `['catalog:write']`, `request.user.permissions = ['catalog:read']` → throws `ForbiddenException`.
  - Metadata `['catalog:write']`, `request.user.permissions = ['catalog:write', 'audit:read']` → allows.
  - Metadata `['catalog:write', 'catalog:publish']`, `request.user.permissions = ['catalog:publish']` → allows (OR-semantics).
  - `request.user` undefined → throws `ForbiddenException` (defensive — `JwtAuthGuard` should already have rejected, but the guard must not surface a TypeError).

## Files to modify

- `libs/auth/index.ts` — `export * from './permissions.guard'; export * from './requires-permission.decorator';`.
- `libs/auth/auth.module.ts` — add `PermissionsGuard` to the `providers` array inside `forRootAsync` and to the `exports` array. (Registration ≠ wiring; the host app still has to add the `APP_GUARD` provider — Nest does not auto-globalize `forRootAsync` providers.)
- `apps/api-gateway/src/app/app.module.ts` — extend imports to include `PermissionsGuard` from `@retail-inventory-system/auth`; append `{ provide: APP_GUARD, useClass: PermissionsGuard }` **after** the existing `RolesGuard` provider. Verify the order in the file matches: `JwtAuthGuard` → `RolesGuard` → `PermissionsGuard`.
- `apps/api-gateway/src/modules/auth/presentation/auth-admin.controller.ts`:
  - Drop `@Roles(RoleEnum.ADMIN)` and replace with `@RequiresPermission(PermissionCodeEnum.AUDIT_READ)` (which the seeded admin role bundles).
  - Update `@ApiForbiddenResponse({ description: 'Admin role required' })` → `@ApiForbiddenResponse({ description: 'audit:read permission required' })`.
  - Update the controller comment block: now this endpoint is the smoke for both `RolesGuard` (still implicit — any authenticated user passes) and `PermissionsGuard` (the new precise gate).
- `test/auth.e2e-spec.ts` — extend the admin smoke. Add two assertions:
  - Admin (has `audit:read`) → `GET /api/auth/admin/ping` returns 200 `{ ok: true }`.
  - A seeded non-admin StaffUser (e.g., `warehouse-staff@example.com` — see task-09's seed set) → `GET /api/auth/admin/ping` returns 403 with `Insufficient permissions`. **If task-09's seed set is not yet in place when this test is added, fixture a one-off non-admin StaffUser inside the test's `beforeAll` instead.**

## Files to delete

None.

## Tests

- Unit: new `libs/auth/spec/permissions.guard.spec.ts` (cases above). Stub `Reflector` minimally — pass it an object whose `getAllAndOverride` returns the test fixture's metadata.
- E2E: extended `test/auth.e2e-spec.ts` per the two assertions above.

## Doc deliverable

Open `docs/implementation/01-baseline-identity-staffuser-customer-rbac/03-permissions-guard-and-decorator.md` (started in task-03). Replace the `<!-- guard-and-decorator-half-anchor -->` marker with the **guard + decorator half**. Target ~120 lines for this half. Sections:

1. **Guard ergonomics.** Show the decorator usage on `/api/auth/admin/ping`. Show what 403 looks like over HTTP.
2. **Interaction with `@Roles()`.** Both decorators are still valid. `@Roles()` is the coarse gate (does this caller belong to a role bundle at all?); `@RequiresPermission()` is the precise gate (does this caller hold this specific atomic capability?). Decision rule: prefer `@RequiresPermission()` for any new endpoint; `@Roles()` is for very-broad gating where you genuinely don't care which permission inside the bundle triggers the access (rare).
3. **Guard ordering.** `JwtAuthGuard` first (auth), `RolesGuard` second, `PermissionsGuard` third. Why this order: each layer's preconditions assume the previous layer's invariants — `RolesGuard` needs `request.user`, `PermissionsGuard` needs `request.user.permissions`.
4. **OR-semantics in the decorator.** Multiple codes listed = any one is sufficient. Cite the line in `permissions.guard.ts` and explain how to do AND if ever needed (apply the decorator twice via stacking — class-level OR plus method-level OR is equivalent to (class OR) AND (method OR); for true within-handler AND, an explicit follow-up epic would add a `RequiresAllPermissions` variant).
5. **No DB hit per request.** Reiterate the trade-off documented in §3 of the inflation half: `request.user.permissions` is sourced from the JWT payload (task-03), so a role-edit through the IAM admin endpoints (task-06) only takes effect on the next refresh.

## Carryover produced

- `PermissionsGuard` and `@RequiresPermission()` exported from `@retail-inventory-system/auth`.
- Third global guard registered in `app.module.ts`.
- `/api/auth/admin/ping` is now gated behind `audit:read`.
- Doc `03-permissions-guard-and-decorator.md` complete.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `libs/auth/spec/permissions.guard.spec.ts` is green.
- [ ] `yarn test:e2e` passes; the new admin/non-admin ping assertions are green.
- [ ] `grep -rn "PermissionsGuard\|RequiresPermission" libs/auth/index.ts apps/api-gateway/src/app/app.module.ts` shows both wired up.
- [ ] `apps/api-gateway/src/app/app.module.ts` registers exactly three `APP_GUARD` providers in the order `JwtAuthGuard`, `RolesGuard`, `PermissionsGuard`.
- [ ] Doc `03-…md` no longer contains the `<!-- guard-and-decorator-half-anchor -->` marker (the anchor has been replaced by the content).
- [ ] No file outside `tmp/` references `tmp/`.
