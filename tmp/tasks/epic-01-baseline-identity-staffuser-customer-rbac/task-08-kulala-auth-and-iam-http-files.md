---
epic: epic-01
task_number: 8
title: Author `http/auth.http` and `http/iam.http` (Kulala) covering existing and new endpoints
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06, task-07]
doc_deliverable: docs/implementation/01-baseline-identity-staffuser-customer-rbac/07-kulala-auth-and-iam-files.md
---

# Task 08 — Author `http/auth.http` and `http/iam.http` (Kulala)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Backfill first-class HTTP documentation for the entire auth + IAM surface. The existing `http/` folder has `order.http` and `product.http` but no `auth.http` — this task corrects that gap and adds `iam.http` for the endpoints task-06 introduced. The files are consumed by the Kulala Neovim plugin (the user works in Neovim, per project context) and double as living documentation for what each endpoint expects.

Mirror the conventions in `http/order.http`: a top-of-file purpose comment with the controller path, `@baseUrl = {{ENV_BASE_URL}}`, one block per request prefixed with `###` and a `# @name <handlerName>` line, and a leading `#` comment that names the route and links to the controller file.

## Entry state assumed

Task-07 carryover present:

- All endpoints in scope exist and respond correctly under fresh seed:
  - `POST /api/auth/login` (deprecated alias) and `POST /api/auth/staff/login` (canonical).
  - `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/admin/ping`.
  - `POST /api/auth/customer/register`, `POST /api/auth/customer/login`, `GET /api/auth/customer/me`.
  - `GET /api/iam/roles`, `POST /api/iam/roles`, `PATCH /api/iam/roles/:id`, `POST /api/iam/staff/:id/roles`, `DELETE /api/iam/staff/:id/roles/:roleName`.
- `http/http-client.env.json` defines `ENV_BASE_URL` (currently `http://localhost:3000/api` based on existing files).

## Scope

**In:**

- Two new files: `http/auth.http`, `http/iam.http`.
- Mirror the `http/order.http` shape exactly (purpose block, `@baseUrl`, `###` separators, `# @name X`, controller-file citations in comments).
- Chain requests using Kulala's `# @name` variable substitution so the IAM file can `{{adminLogin.response.body.$.accessToken}}` instead of asking the operator to copy-paste a token between calls.
- Doc deliverable `07-kulala-auth-and-iam-files.md`.

**Out:**

- Any change to `http/http-client.env.json`. If the file needs a `staffEmail`/`customerEmail`/`adminPassword` variable for convenience, prefer hardcoding in the .http file (matches existing convention) over expanding the env JSON.
- Adding tests around .http files (Kulala is editor tooling, not CI).

## `http/auth.http` — structure

Top comment block describing the file (cite all four controllers: `auth.controller.ts`, `auth-admin.controller.ts`, `customer-auth.controller.ts`, and the multi-prefix staff alias from task-05).

`@baseUrl = {{ENV_BASE_URL}}`.

Then one block per endpoint, in this order:

1. **`# @name staffLogin` — `POST {{baseUrl}}/auth/staff/login`** with body `{ "email": "admin@example.com", "password": "admin1234" }`. Comment: "Canonical staff login. Returns access + refresh tokens. The access JWT carries `permissions: string[]`, inflated at login."
2. **`# @name staffLoginDeprecated` — `POST {{baseUrl}}/auth/login`** with the same body. Comment: "Deprecated alias for back-compat (one release). Same response shape; remove in a future release."
3. **`# @name refresh` — `POST {{baseUrl}}/auth/refresh`** with body `{ "refreshToken": "{{staffLogin.response.body.$.refreshToken}}" }`. Comment: "Rotates both access and refresh tokens; emits `RefreshTokenRotated`. Reusing an already-rotated refresh token triggers `RefreshFailed: rotation reuse detected` and clears the live hash (ADR-010)."
4. **`# @name me` — `GET {{baseUrl}}/auth/me`** with header `Authorization: Bearer {{staffLogin.response.body.$.accessToken}}`. Comment: "Returns the authenticated subject (staff or customer — the validator routes by id). Response includes `permissions: string[]`, inflated at login."
5. **`# @name logout` — `POST {{baseUrl}}/auth/logout`** with header `Authorization: Bearer {{staffLogin.response.body.$.accessToken}}`. Comment: "Clears the server-side refresh token hash. The access JWT remains technically valid until expiry; clients should drop it."
6. **`# @name adminPing` — `GET {{baseUrl}}/auth/admin/ping`** with header `Authorization: Bearer {{staffLogin.response.body.$.accessToken}}`. Comment: "Gated behind `audit:read`. Admin succeeds (200 `{ ok: true }`); a StaffUser without `audit:read` gets 403."
7. **`# @name customerRegister` — `POST {{baseUrl}}/auth/customer/register`** with body `{ "email": "buyer@example.com", "password": "buyer1234", "firstName": "Buy", "lastName": "Er" }`. Comment: "Creates a Customer in `status='active'`, `email_verified_at: null`. Idempotent on duplicate email → 409."
8. **`# @name customerLogin` — `POST {{baseUrl}}/auth/customer/login`** with body `{ "email": "buyer@example.com", "password": "buyer1234" }`. Comment: "Same JWT envelope as staff login but `roles: []` and `permissions: []` — customer is not an RBAC actor."
9. **`# @name customerMe` — `GET {{baseUrl}}/auth/customer/me`** with `Authorization: Bearer {{customerLogin.response.body.$.accessToken}}`. Comment: "Returns the Customer's profile. The same JWT is rejected by `/auth/admin/ping` because the customer lacks `audit:read`."

## `http/iam.http` — structure

Top comment block citing `iam.controller.ts` and noting that **all routes require a staff JWT with `iam:role-edit` or `iam:assign`** — the seeded `admin@example.com` user has both.

A `# Prereqs:` block at the top: "Run `# @name adminLogin` first; later calls reference `{{adminLogin.response.body.$.accessToken}}`."

Then:

1. **`# @name adminLogin` — `POST {{baseUrl}}/auth/staff/login`** with admin creds. (Mirrors the auth.http block; duplicated here so iam.http stands alone.)
2. **`# @name listRoles` — `GET {{baseUrl}}/iam/roles`** with admin Authorization header. Comment: "Returns all roles + their permission codes, sorted by name. Requires `iam:role-edit`."
3. **`# @name createRole` — `POST {{baseUrl}}/iam/roles`** with body `{ "name": "ops-readonly", "description": "Operations team read-only access", "permissionCodes": ["catalog:read", "inventory:read", "order:read"] }`. Comment: "Validates name (kebab-case), checks every permission code against the registry; 409 on duplicate name, 400 on unknown code."
4. **`# @name patchRole` — `PATCH {{baseUrl}}/iam/roles/{{createRole.response.body.$.id}}`** with body `{ "description": "Ops team (read + audit)", "permissionCodes": ["catalog:read", "inventory:read", "order:read", "audit:read"] }`. Comment: "Replaces the permission set (not merge). Single transaction in the adapter."
5. **`# @name assignStaffRole` — `POST {{baseUrl}}/iam/staff/{{adminLogin.response.body.$.user.id}}/roles`** with body `{ "roleNames": ["ops-readonly"] }`. Comment: "Idempotent. Reassigning the same role is a no-op."
6. **`# @name revokeStaffRole` — `DELETE {{baseUrl}}/iam/staff/{{adminLogin.response.body.$.user.id}}/roles/ops-readonly`**. Comment: "204 on success; 404 if the role is not currently bound; 409 if it would leave the StaffUser with no roles."

## Files to add

- `http/auth.http` (structure above).
- `http/iam.http` (structure above).
- `docs/implementation/01-baseline-identity-staffuser-customer-rbac/07-kulala-auth-and-iam-files.md`.

## Files to modify

None.

## Files to delete

None.

## Verification

Manual against a freshly-seeded gateway (`docker compose up -d mysql redis rabbitmq && yarn migration:run && yarn seed && yarn start:dev:api-gateway`):

- Open `http/auth.http` in Neovim with Kulala. Send `staffLogin`; verify 200 + tokens. Send `me`; verify the response includes `permissions: ['audit:read', 'catalog:publish', ...]`. Send `adminPing`; verify 200.
- Open `http/iam.http`. Send `adminLogin`, then `createRole`, then `patchRole`, then `assignStaffRole`, then `revokeStaffRole`. Verify each succeeds with the documented status code.

## Doc deliverable

Write `docs/implementation/01-baseline-identity-staffuser-customer-rbac/07-kulala-auth-and-iam-files.md`. Target ~80 lines. Sections:

1. **What Kulala is.** One sentence + a pointer to the plugin's docs. Why .http files: they are a checked-in, version-controlled alternative to Postman collections, browsable inside the editor.
2. **File overview.** `http/auth.http` covers the auth controllers (staff + customer); `http/iam.http` covers the IAM admin controller. They are independent — neither imports the other; the redundancy of the `adminLogin` block is intentional.
3. **Conventions.** `@baseUrl = {{ENV_BASE_URL}}` reads from `http/http-client.env.json`. Each block has a `# @name X` so later blocks can reference `{{X.response.body.$.path}}`.
4. **Operator workflow.** Step-by-step for "I want to manually test a new IAM endpoint": run the gateway, open the .http file, send `adminLogin`, then send the test request. Variables auto-substitute.
5. **What's missing.** No `.http` file for retail or inventory endpoints under the seeded auth — operators currently copy the JWT manually into `http/order.http` and `http/product.http`. Either of those is a candidate for a follow-up cleanup (out of scope here).

## Carryover produced

- Two new `.http` files; one new doc.

## Exit criteria

- [ ] `http/auth.http` and `http/iam.http` exist and mirror the conventions of `http/order.http`.
- [ ] Every endpoint listed in this task's "Scope → In" appears in one of the two files.
- [ ] Operator can execute every block in `http/auth.http` (in order) and every block in `http/iam.http` (in order) against a freshly-seeded gateway — each request succeeds with the documented status code.
- [ ] Doc `07-kulala-auth-and-iam-files.md` exists.
- [ ] No file outside `tmp/` references `tmp/`.
