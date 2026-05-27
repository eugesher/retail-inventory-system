---
epic: epic-01
task_number: 3
title: Inflate the JWT permissions claim on login + refresh, surface permissions on `ICurrentUser`
depends_on: [task-01, task-02]
doc_deliverable: docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/03-permissions-guard-and-decorator.md
---

# Task 03 — Inflate JWT permissions claim on login + refresh, surface on `ICurrentUser`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Turn the relational role-to-permission binding (task-01) into a per-request bit of metadata that downstream guards can read without a DB hit. At login and at refresh, flatten the StaffUser's roles → permissions and embed `permissions: string[]` in the access JWT. Surface the same array on `ICurrentUser` (which `request.user` resolves to) so `PermissionsGuard` (task-04) can simply read `request.user.permissions` and intersect with `@RequiresPermission()` metadata.

This task does **not** add the guard or the decorator — those land in task-04. This task only extends the payload contract, the issuance path, and the validator.

## Entry state assumed

Task-02 carryover present:

- `StaffUser` aggregate has `roles: RoleAggregate[]`, each `RoleAggregate` carries `permissions: Set<PermissionCodeEnum>`.
- `LoginUseCase`, `RefreshTokenUseCase` issue tokens via `ITokenPort.issueAccessToken({ sub, email, roles, jti })` where `roles: RoleEnum[]`.
- `JwtStrategy` resolves a payload to `ICurrentUser` via `AUTH_USER_VALIDATOR.validate(payload)` (currently `ValidateStaffUserUseCase`); `ICurrentUser` exposes `{ id, email, roles: RoleEnum[] }`.
- `IJwtAccessPayload` has `{ sub, email, roles: RoleEnum[], jti, iat?, exp? }`.

## Scope

**In:**

- Extend `IJwtAccessPayload` with `permissions: string[]`.
- Extend `ICurrentUser` with `permissions: string[]`.
- `LoginUseCase` + `RefreshTokenUseCase` derive the flattened permission set from the loaded `StaffUser`'s roles and pass it to `tokens.issueAccessToken(...)`.
- `ValidateStaffUserUseCase` (the JWT validator) returns `permissions` on `ICurrentUser` by reading them off the loaded `StaffUser`. Two options are acceptable here:
  1. **Trust the payload**: surface `payload.permissions` directly without a DB round-trip (fast; matches the epic's "JWT must already carry resolved permission codes" wording).
  2. **Re-load from DB**: read the live permission set from the `StaffUser`'s roles on every request (slow but always up-to-date).

  Choose option (1) for this epic — the relevant epic line is in §Test Strategy ("the JWT must already carry resolved permission codes"). Document the trade-off in the doc deliverable: a role-edit (task-06) won't take effect for tokens already in circulation until the next refresh. Note in the doc that this is intentional and matches the "last-writer-wins" stance from the epic.
- Update all auth-use-case spec files to assert that `permissions` is present on the issued payload + on the returned `user` object.
- Doc deliverable: write the **JWT inflation half** of `03-permissions-guard-and-decorator.md` — task-04 will append the guard/decorator half.

**Out:**

- `PermissionsGuard` and `@RequiresPermission()` — task-04.
- Any controller change — task-04 re-gates `/auth/admin/ping`; this task leaves controllers alone.
- Customer endpoints / customer JWT — task-05 (the customer JWT has no `permissions` claim because customers are not RBAC actors; the same `IJwtAccessPayload` shape is reused with `permissions: []`).

## Files to modify

- `libs/contracts/auth/jwt-payload.dto.ts` — add `permissions: string[]` to `IJwtAccessPayload`. (Refresh payload is unchanged — refresh tokens still carry `{ sub, jti }` only.)
- `libs/contracts/auth/current-user.dto.ts` — add `permissions: string[]` to `ICurrentUser`.
- `apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts`:
  - Build `const permissions = Array.from(new Set(user.roles.flatMap((role) => Array.from(role.permissions)))).sort();` (sort for determinism — makes test assertions stable and helps cache reuse).
  - Pass `permissions` into both `tokens.issueAccessToken(...)` and the returned `user: { id, email, roles, permissions }`.
- `apps/api-gateway/src/modules/auth/application/use-cases/refresh-token.use-case.ts` — same change (compute `permissions` on the freshly-loaded `StaffUser`, pass into the new access JWT).
- `apps/api-gateway/src/modules/auth/application/use-cases/validate-staff-user.use-case.ts`:
  - Implementation choice: prefer the payload-trusting path. The validator's contract becomes "given a verified payload, return the `ICurrentUser` it represents" — meaning `{ id: payload.sub, email: payload.email, roles: payload.roles, permissions: payload.permissions ?? [] }`. The `?? []` is a defensive default for tokens issued before this task's deploy (one-release tolerance); in a green field it could be `payload.permissions` directly.
  - The repo lookup remains, but only to verify `user.isActive`; the result's `roles`/`permissions` come from the payload, not from the row.
- `apps/api-gateway/src/modules/auth/application/use-cases/spec/login.use-case.spec.ts`, `refresh-token.use-case.spec.ts`, `validate-staff-user.use-case.spec.ts`:
  - For login + refresh: fixture a `StaffUser` with two roles whose permission sets overlap; assert that the access token issuance call receives a deduplicated, sorted `permissions` array.
  - For validate-staff-user: assert that an inbound payload's `permissions` flow through to the returned `ICurrentUser` unchanged.
- `apps/api-gateway/src/modules/auth/infrastructure/jwt/jwt-token.adapter.ts` — no signature change (still accepts `Omit<IJwtAccessPayload, 'iat' | 'exp'>`); the new `permissions` field rides along for free now that it's on the type. Add a unit test (if one exists) or rely on the use-case tests.
- `libs/auth/jwt.strategy.ts` — no code change needed (it forwards to `userValidator.validate(payload)`); but verify the resulting `ICurrentUser` carries the new field and is what gets attached to `request.user`.
- `apps/api-gateway/src/modules/auth/presentation/dto/current-user.response.dto.ts` — expose `permissions: string[]` on the `/auth/me` response so the client can introspect (purely additive; existing fields untouched).
- `apps/api-gateway/src/modules/auth/presentation/auth.controller.ts` — update the `me()` handler to project `user.permissions` into the response DTO.
- `test/auth.e2e-spec.ts` — extend the admin login → `/auth/me` assertion to expect `permissions` to be non-empty and to include `audit:read` (admin has every permission). Decode the access token (use `jsonwebtoken` already in the dep set, or a base64 split) and assert the payload's `permissions` claim shape.

## Files to add

- `apps/api-gateway/src/modules/auth/application/use-cases/spec/permissions-inflation.spec.ts` — focused unit test that walks the `LoginUseCase` with a StaffUser bound to `admin` + `catalog-manager`, asserts the issued access token payload has all distinct codes from both roles, sorted ASC, with no duplicates.

## Files to delete

None.

## Tests

- Unit:
  - Updated `login.use-case.spec.ts`: assert `tokens.issueAccessToken` is called with `permissions` (deduped + sorted).
  - Updated `refresh-token.use-case.spec.ts`: same assertion after a successful rotation.
  - Updated `validate-staff-user.use-case.spec.ts`: input payload's `permissions` flows through unchanged.
  - New `permissions-inflation.spec.ts`: multi-role merge invariant (dedup + sort).
- E2E:
  - Extended `test/auth.e2e-spec.ts`: admin login → assert decoded access JWT carries `permissions: string[]` with at least `audit:read` present; `/auth/me` response DTO includes `permissions`.

## Doc deliverable

Append the **JWT inflation half** to `docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/03-permissions-guard-and-decorator.md`. Create the file in this task — leave a clear `<!-- guard-and-decorator-half-anchor -->` marker at the end for task-04. Sections to write now:

1. **Why inflate at issue time.** Trade off: hot-path DB lookup per request vs. one-DB-lookup per login. RBAC reads dominate writes; inflation amortises the cost across the JWT's lifetime. Cite the epic's §Test Strategy line "the JWT must already carry resolved permission codes".
2. **The merge algorithm.** Set-union across the StaffUser's bound roles, sort ASC. Why sorted: deterministic tests + better caching downstream (an HTTP edge cache or CDN can use the JWT body's hash as a cache key without spurious misses from claim reordering).
3. **Refresh path.** Refresh tokens carry only `sub` + `jti` — when refresh succeeds, the new access JWT is re-inflated from the live `StaffUser` rows. This is the only point at which a role-edit (task-06) takes effect for an already-signed-in StaffUser.
4. **Customer JWT.** Forward reference to task-05: customers reuse the same `IJwtAccessPayload` shape with `permissions: []` and `roles: []`. The customer JWT exists only to identify the buyer; it does not gate any RBAC endpoint.
5. **Anchor for task-04.** End with `<!-- guard-and-decorator-half-anchor -->`.

## Carryover produced

- `IJwtAccessPayload.permissions: string[]` and `ICurrentUser.permissions: string[]` in `libs/contracts/auth/`.
- Every access JWT issued by the gateway now embeds the flattened permission set.
- `request.user.permissions` is populated on every authenticated request — ready for `PermissionsGuard` in task-04.
- `/auth/me` response DTO surfaces `permissions`.
- Doc `03-permissions-guard-and-decorator.md` with the inflation half done + the task-04 anchor.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes — all updated/new use-case specs are green.
- [ ] `yarn test:e2e` passes — admin login decodes a JWT whose `permissions` array contains every code in `PermissionCodeEnum`.
- [ ] `IJwtAccessPayload` and `ICurrentUser` both carry `permissions: string[]`; a `grep -rn "permissions" libs/contracts/auth/` shows both types declare the field.
- [ ] Doc `03-permissions-guard-and-decorator.md` exists with the inflation half done.
- [ ] No file outside `tmp/` references `tmp/`.
