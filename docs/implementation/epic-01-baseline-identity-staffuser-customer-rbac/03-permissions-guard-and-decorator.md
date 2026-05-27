# 03 — Permissions Guard and `@RequiresPermission()` Decorator

This document records the JWT-inflation half of the permission-gating
work landed in epic-01 task-03; the guard + decorator half is appended
in task-04 below the anchor at the bottom of this file. The
relational model that this builds on is documented in
[`02-role-and-permission-relational-model.md`](./02-role-and-permission-relational-model.md);
the access-control architecture lives in
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md).

## 1. Why inflate the permissions claim at issue time

The pre-epic gateway answered authorization questions by reading
`request.user.roles: RoleEnum[]` — a fixed-cardinality enum stamped onto
the JWT at login. With task-01's relational `permission` table, the
authorization vocabulary is no longer a TypeScript artifact: an operator
edits `role_permissions` rows through task-06's admin endpoints and the
change must propagate to every gateway pod without a redeploy.

That leaves two ways for `PermissionsGuard` (task-04) to learn which
codes the current request carries:

1. **Look them up per request.** On every authenticated call, load the
   StaffUser, walk their `Role[]`, and union the `Permission[]` columns.
   That's two extra MySQL round-trips on every request behind the
   global guard, dominated by the join.
2. **Inflate them once at issue time.** At login (and at every refresh)
   the gateway flattens the StaffUser's role-bound permissions into a
   sorted, deduplicated `string[]` and embeds it as a `permissions`
   claim on the access JWT. The guard reads `request.user.permissions`
   directly — no DB lookup on the hot path.

The epic mandates option 2: the test strategy line on
`libs/auth/spec/permissions.guard.spec.ts` reads *"the JWT must already
carry resolved permission codes (the JWT-issue path inflates roles →
permissions on login)"*. The trade-off is intentional: RBAC reads
dominate writes by orders of magnitude in a retail backend, so
inflating once amortises the DB cost across the JWT's full lifetime.

The cost of that choice is that a role-edit (task-06) does **not** take
effect for tokens already in circulation. The next refresh (≤15m later
by default — `JWT_ACCESS_EXPIRES_IN`) picks up the new permission set;
between the edit and that refresh, the guard sees the stale claim. This
matches the epic's "last-writer-wins" stance on permission propagation
and is documented as expected behavior for operators in the task-06 doc.

## 2. The merge algorithm

`LoginUseCase` and `RefreshTokenUseCase` both compute the claim with the
same one-liner:

```ts
const permissions = Array.from(
  new Set(user.roles.flatMap((role) => Array.from(role.permissions))),
).sort();
```

Three properties of this expression are load-bearing:

- **Set-union dedupes.** Two roles sharing `catalog:read` produce one
  entry, not two. The wire size of the JWT stays bounded by the size of
  `PermissionCodeEnum` (12 codes today), not by the number of roles
  bound to the StaffUser.
- **`sort()` makes the array deterministic.** Same StaffUser + same
  role-permission bindings → byte-identical JSON payload. That matters
  for two reasons. Test assertions can rely on `toEqual(expected)`
  without `expect.arrayContaining` gymnastics. And downstream caches
  (HTTP edge cache, CDN, future per-route response cache) can use the
  JWT body's hash as a stable cache key without spurious misses from
  claim reordering across two pods of the same gateway.
- **`Array.from(role.permissions)` flattens the domain `ReadonlySet`.**
  `RoleAggregate.permissions` is a `ReadonlySet<PermissionCodeEnum>`
  (see `apps/api-gateway/src/modules/auth/domain/role.aggregate.ts:49`).
  The enum values are `string`-typed, so the resulting `string[]` lines
  up with `IJwtAccessPayload.permissions: string[]` without a cast.

Both use cases compute the array independently — `RefreshTokenUseCase`
deliberately does *not* trust the claim on the inbound refresh token.
It re-loads the live `StaffUser` row, then re-inflates from the live
`role_permissions` bindings. This is the only path that picks up a
task-06 role-edit for an already-signed-in actor.

## 3. The validator's contract

`ValidateStaffUserUseCase` (the `IAuthUserValidator` implementation
bound to `AUTH_USER_VALIDATOR` in `auth.module.ts`) is what
`libs/auth`'s `JwtStrategy` calls on every authenticated request. Its
contract now reads: *"given a verified access payload, return the
`ICurrentUser` it represents, asserting only that the underlying row is
still active."*

```ts
public async validate(payload: IJwtAccessPayload): Promise<ICurrentUser> {
  const user = await this.users.findById(payload.sub);
  if (!user?.isActive) {
    throw new UnauthorizedException('Account is no longer active');
  }

  return {
    id: payload.sub,
    email: payload.email,
    roles: payload.roles,
    permissions: payload.permissions ?? [],
  };
}
```

Two things to notice:

- **The row lookup is preserved** — not for `roles`/`permissions`, but
  to honor suspension and soft-delete. A StaffUser whose account is
  suspended between two requests must be rejected on the second one,
  even if their access JWT has not expired. The 401 from this branch is
  the kill-switch for token revocation in the absence of a JWT blacklist.
- **`payload.permissions ?? []`** is the one-release-tolerance default.
  Tokens minted before this deploy carry no `permissions` claim; their
  next refresh repopulates the claim. The fallback prevents a stale
  token from crashing the guard with `Cannot read properties of
  undefined` during the rollover window. In a green field the `?? []`
  could be `payload.permissions` directly.

## 4. The customer JWT

Task-05 introduces customer authentication (`/api/auth/customer/login`)
on the same `IJwtAccessPayload` shape. The customer JWT reuses the type
exactly — including `permissions: string[]` — but the array is always
empty: customers are not RBAC actors. They get a JWT only so the
gateway can identify *who* is buying, not *what* they may do. No
`@RequiresPermission()` route ever admits a customer JWT, because no
customer JWT ever carries a non-empty permission set.

Reusing one payload shape (and one strategy / validator pair) means the
guard does not need to branch on actor type. The customer aggregate
lives in a separate table (task-05), but it shares the gateway's JWT
surface — and so it shares the type.

## 5. What this enables for task-04

After this task, on every authenticated request:

- `request.user.permissions: string[]` is populated.
- The array is sorted, deduplicated, and built from the live
  `role_permissions` bindings as of the most recent login or refresh.
- The same array is on the access JWT body — so the gateway and any
  future service that verifies the gateway's tokens off-host see the
  same authorization view.

Task-04 will read `request.user.permissions` inside a `PermissionsGuard`
and intersect it with `@RequiresPermission('iam:role-edit')` metadata
on a controller method. The guard never re-loads from the DB.

## 6. Guard ergonomics

The decorator is a `SetMetadata` wrapper. Applied at the method level on a
controller, it tells `PermissionsGuard` to admit the request only if
`request.user.permissions` includes at least one of the listed codes:

```ts
// apps/api-gateway/src/modules/auth/presentation/auth-admin.controller.ts
@Controller('auth/admin')
export class AuthAdminController {
  @Get('ping')
  @RequiresPermission(PermissionCodeEnum.AUDIT_READ)
  @ApiBearerAuth()
  public ping(): { ok: true } {
    return { ok: true };
  }
}
```

A StaffUser whose bundled role does not carry `audit:read` hits the
guard's 403 branch:

```
HTTP/1.1 403 Forbidden
content-type: application/json

{
  "statusCode": 403,
  "message": "Insufficient permissions",
  "error": "Forbidden"
}
```

The seeded `admin` role bundles all 12 codes (see
[`02-role-and-permission-relational-model.md`](./02-role-and-permission-relational-model.md))
and so admits the request with `200 {"ok":true}`. That asymmetry is the
test fixture exercised by the two assertions in `test/auth.e2e-spec.ts`'s
`Permissions guard (/api/auth/admin/ping)` block.

## 7. Interaction with `@Roles()`

`@Roles()` and `@RequiresPermission()` are both valid and live side by
side on the same controller. They answer different questions:

- **`@Roles(RoleEnum.X, …)`** — coarse gate. *Does this caller belong to
  any of the listed role bundles at all?* Useful when you genuinely do
  not care which specific atomic capability within the bundle triggers
  the access — e.g. a service-status endpoint open to "anyone with a
  staff role" regardless of which permissions that role grants.
- **`@RequiresPermission(PermissionCodeEnum.X, …)`** — precise gate.
  *Does this caller hold this specific atomic capability?* This is the
  decorator to reach for on every new endpoint: it survives role
  reorganization (operators can move `catalog:write` from
  `catalog-manager` to a new role without re-decorating handlers), and
  it makes the authorization intent of a route literally readable in the
  decorator line.

**Decision rule.** Prefer `@RequiresPermission()` on every new endpoint.
`@Roles()` stays as a coarse fallback — useful in places where the
authorization predicate is genuinely "any staff role" rather than a
specific capability. The existing `@Roles()` annotations on retail and
inventory routes (gating `RoleEnum.ADMIN, RoleEnum.CUSTOMER`) remain
correct under that lens and are not retargeted in this task.

## 8. Guard ordering

Three global guards are wired in `apps/api-gateway/src/app/app.module.ts`
in this order — and the order is load-bearing, not cosmetic:

```ts
providers: [
  { provide: APP_GUARD, useClass: JwtAuthGuard },      // 1. authenticate
  { provide: APP_GUARD, useClass: RolesGuard },        // 2. role bundle
  { provide: APP_GUARD, useClass: PermissionsGuard },  // 3. atomic code
],
```

Nest invokes `APP_GUARD` providers in registration order; any one that
returns `false` or throws short-circuits the rest of the chain. Each
layer's preconditions assume the previous layer's invariants:

- `JwtAuthGuard` runs first because nothing further makes sense without
  `request.user` populated by `JwtStrategy.validate(...)`. A request
  missing a valid bearer token returns 401 here and the role / permission
  guards never see it.
- `RolesGuard` runs next. It needs `request.user.roles` (set by
  `ValidateStaffUserUseCase` — see §3 above). For routes without
  `@Roles()` metadata it is a no-op pass-through.
- `PermissionsGuard` runs last. It needs `request.user.permissions` —
  also set by `ValidateStaffUserUseCase`, sourced from
  `IJwtAccessPayload.permissions`. For routes without
  `@RequiresPermission()` metadata it is a no-op pass-through.

The two no-op pass-throughs are deliberate: a global guard chain that
charged 403 on missing metadata would force every public-by-`@Public()`
route to also list `@RequiresPermission()`, which would couple the
authentication opt-out to the authorization vocabulary and defeat the
single-knob `@Public()` ergonomic from ADR-010.

## 9. OR-semantics in the decorator

`PermissionsGuard.canActivate` uses `required.some((code) =>
user.permissions.includes(code))` — multiple codes on the same decorator
call mean *any one is sufficient*:

```ts
@RequiresPermission(
  PermissionCodeEnum.CATALOG_WRITE,
  PermissionCodeEnum.CATALOG_PUBLISH,
)
public update(): … { … }
```

A caller with either `catalog:write` *or* `catalog:publish` passes. The
unit suite locks this in (`libs/auth/spec/permissions.guard.spec.ts`
*"allows when the caller holds any one of multiple required permissions
(OR-semantics)"*).

**Why no AND-semantics yet.** `Reflector.getAllAndOverride([handler,
class])` walks the two layers but the *method-level* decorator
overrides the class-level one rather than merging them — so stacking
`@RequiresPermission(A)` at the class with `@RequiresPermission(B)` at
the method does *not* produce `A AND B`. It produces `B`. A true
within-handler AND would require either a `RequiresAllPermissions(A, B)`
variant (read by `getAllAndMerge` instead of `getAllAndOverride`) or a
second decorator that the guard ANDs against the first. Neither lands
in epic-01 — no current route needs AND-semantics. If a future epic
does, the cleanest extension is the dedicated `RequiresAllPermissions`
variant; the guard would read both metadata keys and require *all* the
ALL-codes plus *any one* of the OR-codes.

## 10. No DB hit per request

`PermissionsGuard.canActivate` is purely in-memory: it reads metadata
off the handler / class via `Reflector` and intersects it with
`request.user.permissions` — a `string[]` already on the request from
`JwtStrategy.validate(...)`. There is no repository, no cache, no
network call. The cost is one array `.some()` per gated request.

This is the payoff of §1's inflate-at-issue choice. The corollary is
the staleness window §1 also called out: a role-edit through task-06's
IAM admin endpoints does not retroactively change tokens already in
circulation. The next refresh (≤ `JWT_ACCESS_EXPIRES_IN` later — 15
minutes by default) re-inflates the claim from the live
`role_permissions` bindings; between the edit and that refresh, the
guard sees the stale claim.

This is the intentional trade for never paying a DB hit on the guard's
hot path, and it is the line operators of the IAM admin endpoints (task-06)
need to know about. Token revocation under the same model rides on
`StaffUser.isActive`: a suspended user is rejected by
`ValidateStaffUserUseCase` regardless of permission staleness, so the
worst-case window for *who* may act is bounded by the request, not by
JWT lifetime.

