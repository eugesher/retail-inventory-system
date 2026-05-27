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

<!-- guard-and-decorator-half-anchor -->
