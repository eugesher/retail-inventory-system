# 04 — Customer register and login

This document records the buyer-side identity baseline. The
staff/customer split argument lives in
[`01-staffuser-customer-split.md`](./01-staffuser-customer-split.md);
the architectural decision this implements is
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md).

## 1. Endpoint surface

The gateway gains three customer-side HTTP routes and an alias /
canonical pair on the staff side. The "deprecated alias" column keeps
`/api/auth/login` working for one release so existing staff clients
have a window to migrate.

| Method | Path                              | Auth          | Notes                                              |
| ------ | --------------------------------- | ------------- | -------------------------------------------------- |
| POST   | `/api/auth/customer/register`     | `@Public()`   | Creates a `customer` row in `status='active'`.     |
| POST   | `/api/auth/customer/login`        | `@Public()`   | Issues an access + refresh JWT pair.               |
| GET    | `/api/auth/customer/me`           | Bearer        | Returns the authenticated customer profile.       |
| POST   | `/api/auth/staff/login`           | `@Public()`   | New canonical path for staff login.                |
| POST   | `/api/auth/login`                 | `@Public()`   | Deprecated alias — staff login, kept one release.  |
| POST   | `/api/auth/refresh`               | `@Public()`   | Same handler for both subject kinds.               |
| POST   | `/api/auth/logout`                | Bearer        | Clears the live refresh-token hash.                |
| GET    | `/api/auth/me`                    | Bearer        | Returns `ICurrentUser` from `request.user`.        |

The two staff-login URLs share a single handler via a multi-prefix
`@Controller(['auth', 'auth/staff'])` on `StaffLoginController` — Nest
mounts the same route at both prefixes and there is exactly one code
path producing the response, so the alias can never drift in behavior
from the canonical path. `AuthController` keeps `refresh`/`logout`/`me`
at `/auth/*`; those routes are subject-kind agnostic and the staff/
customer prefixes do not duplicate them.

## 2. Payload symmetry

The customer access JWT reuses the existing `IJwtAccessPayload` shape
from `@retail-inventory-system/contracts/auth`. Every field is the same
as on a staff JWT; the customer JWT simply lands with `roles: []` and
`permissions: []`:

```ts
// access JWT payload (staff vs. customer)
{ sub: '<uuid>', email: '<lower>', roles: [...], permissions: [...], jti: '<uuid>', iat, exp }
```

Two consequences of keeping the envelope identical:

1. **No `subjectKind` discriminator on the token.** A token issued
   before this work continues to validate after the rollout — staff
   tokens validated against the staff repo as before, no re-issue
   needed. The discriminator question moves from "what's in the
   token?" to "which repo answered `findById(payload.sub)`?", and
   that question is answered server-side by
   `ValidateJwtSubjectUseCase` (next section).
2. **`request.user` has one shape everywhere downstream.** Controllers,
   pipes, and the global guards never branch on "is this a staff or
   a customer caller" — they read `request.user.permissions` (always a
   `string[]`, possibly empty) and decide. The
   `PermissionsGuard` thus rejects every customer JWT
   from every `@RequiresPermission()`-gated route by construction; the
   customer's empty `permissions` set can never satisfy a non-empty
   required set. That property is asserted by
   `test/auth-customer.e2e-spec.ts`.

The validator that turns a payload into a user is renamed from
`ValidateStaffUserUseCase` to `ValidateJwtSubjectUseCase`. Its logic:

1. Try `STAFF_USER_REPOSITORY.findById(payload.sub)`. Hit + active →
   return.
2. On miss (or inactive), try `CUSTOMER_REPOSITORY.findById(payload.sub)`.
   Hit + active → return.
3. Both miss → throw `UnauthorizedException`.

The fallback is **staff-first** because the staff `findById` is the hot
path for every back-office request; reversing the order would add a
spurious customer lookup to every staff call.

## 3. Registration semantics

`POST /api/auth/customer/register` is `@Public()` (no Bearer required —
the buyer doesn't have a token yet). The use case:

- Lowercases + trims the submitted email.
- Rejects with 409 on a uniqueness conflict (`UC_CUSTOMER_EMAIL`).
- Hashes the password via the same `Argon2PasswordAdapter` the staff
  side uses (OWASP-2024 cost defaults from
  [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md)).
- Inserts a `customer` row with `status='active'`,
  `email_verified_at=NULL`, `password_hash=<argon2>`,
  `refresh_token_hash=NULL`.
- Returns the profile DTO (no token).

Email verification is *not* implemented in this baseline — the column is in
place so the future verification flow can stamp it without a schema
migration. There is no email-send side-effect today; the route is the
buyer's first contact with the system and produces a row that can
authenticate at `/login` immediately.

There is intentionally **no role assignment** during customer
registration. Customers are not RBAC actors; the gateway holds nothing
on the customer row that the staff RBAC framework would read. That is
also why `customer.roles` does not exist as a column: a non-empty
`roles[]` on a customer row is a bug, not a feature.

## 4. Forward-compatible columns

The `customer` table's column shape already accepts two flows that this
baseline does *not* implement:

- **Q7 — every order creates a Customer.** Future checkout work extends
  the order domain so a checkout (including a guest checkout with no password)
  produces a `customer` row with `status='guest'`,
  `password_hash=NULL`, and whatever PII the buyer agreed to share
  (typically `email` + maybe `first_name`/`last_name`). The aggregate
  enforces the matching invariant: `passwordHash` may be `null` only
  when `status` is `'guest'` or `'deleted'`. A guest row is
  `isActive === false`, so `LoginCustomerUseCase` cannot mint a token
  against it; the guest must claim the row by going through
  `POST /api/auth/customer/register` later (the future guest-claim flow).
- **Q6 — tombstone-friendly deletion.** Every PII column on `customer`
  is nullable. The future GDPR erasure flow flips `status` to
  `'deleted'` and nulls `email`, `phone`, `first_name`, `last_name`,
  `password_hash`, `refresh_token_hash` — preserving the row's `id`
  for FK resolution from historical order lines. The `customer.email`
  UNIQUE constraint applies to non-NULL values only in MySQL, so a
  tombstoned row does not block a fresh signup at the same address.

The shape is therefore "support tomorrow's flows without dropping
today's invariants": the active path requires `password_hash NOT NULL`
at the domain level, the database accepts `NULL` for the future paths,
and the aggregate's constructor is the gate that prevents impossible
combinations (e.g. `status='active'` + `password_hash=NULL`).

## 5. No permission decorators on customer routes

Customer routes never use `@RequiresPermission()`. Three of the four
guards apply globally (`JwtAuthGuard`, `RolesGuard`,
`PermissionsGuard` — all wired in `AppModule` via `APP_GUARD`), but the
customer endpoints either:

- **opt out via `@Public()`** — register and login, because the buyer
  is unauthenticated when these are called; or
- **rely on `JwtAuthGuard` + `@CurrentUser()` only** — `/me`, which
  needs the JWT to identify the row but does not gate on any
  permission code.

A customer JWT carries `permissions: []`. Any handler that requires a
non-empty permission set will reject it; the route table above has no
such handler on the customer side. The 403 from
`/api/auth/admin/ping` is *not* a customer-specific code path — it's
the same `PermissionsGuard` that already gates that route for a
warehouse-staff JWT. The customer case is just another caller without
`audit:read` in their `permissions[]`. That parity is intentional: the
guard does not need to know about subject kinds, and it does not.

## 6. References

- [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
  — accepted decision that motivates the split.
- [`01-staffuser-customer-split.md`](./01-staffuser-customer-split.md)
  — the matching staff half and the original "why split" argument; the
  customer half is appended below the anchor in that document.
- [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md) — the JWT +
  argon2id baseline that the customer side reuses unchanged.
