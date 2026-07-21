# Staff & Access Control extension guides

The eighth cluster of [`docs/extensions/`](../../extensions/README.md) — seven forward-looking sketches
of capabilities the core deliberately does not have, all of them attached to the same place: the
authorization chain. What follows records what was verified out of the source before the guides were
written, the two questions the cluster turns on, and one short note per guide.

The guides themselves are the deliverable; this note explains **why they say what they say**, and in
particular why several of them say "not there" about the place a plausible sketch would have put things.

---

## Why this cluster needed more verification than the others

Every other cluster's guides attach to an aggregate or a use case, and a wrong detail produces a
misleading sketch. Here a wrong detail produces an **authorization hole** that reads as reasonable —
which is the failure mode this note exists to prevent, and the reason the counts and bundles below were
read out of the source rather than lifted from any document.

### The permission registry

`libs/contracts/auth/permission.enum.ts` holds **22** `PermissionCodeEnum` members across seven
resource prefixes (`catalog:`, `inventory:`, `order:`, `notifications:`, `iam:`, `audit:`, `pricing:`,
`customer:`). Two facts about it shaped three guides:

- **A code is not live until it is also seeded.** `PERMISSION_SEEDS` in `scripts/test-db-seed.ts` must
  carry a row for every enum member, because `seedRoles` resolves each code to a seeded id and
  **throws, naming the code**, when one is missing. The `admin` role's bundle is literally
  `Object.values(PermissionCodeEnum)`, so a member added to the enum and forgotten in the seed reaches
  **no role at all** — including `admin`. Every guide that proposes a new code says so.
- **The code format forbids a scope.** `PermissionAggregate` enforces `^[a-z][a-z-]*:[a-z][a-z-]*$` —
  letters and hyphens either side of one colon, no digits, no second colon, no `@`. The invariant lives
  in the domain expressly so it also holds for codes built from non-enum strings. This is the single
  most useful thing discovered this session: the cheap way to add scoping (`inventory:adjust@store-7`)
  is rejected by the model, and it is rejected for the right reason — it would end
  `PermissionCodeEnum`'s status as an enumerable registry.

### The seeded role bundles

`ROLE_SEEDS` installs four roles: `admin` (every code in the registry, by construction),
`catalog-manager` (the three `catalog:` codes plus `pricing:write`), `warehouse-staff` (the four
`inventory:` codes plus `order:fulfill` and `order:cancel`), and `order-support` (`order:read`,
`order:capture`, `order:fulfill`, `order:cancel`, `order:refund`, `order:return-authorize`). The four
names are the **floor, not the ceiling** — [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
records that admin tooling may add a fifth at runtime, and `RoleEnum` is a typed registry of the seeded
names rather than the authorization source of truth. Two guides depend on that: a mandate keyed on role
*names* silently fails to cover a runtime-added role, and an identity provider's group→role mapping is
therefore configuration over rows rather than a code change.

### The guard chain

Three global guards are registered as `APP_GUARD` providers in
`apps/api-gateway/src/app/app.module.ts`, in this order:

```
JwtAuthGuard → RolesGuard → PermissionsGuard
```

- `@Public()` short-circuits **only** `JwtAuthGuard`. The other two still execute on a public route and
  pass it, because `enforceRequiredClaim` returns `true` when a route declares no metadata. That
  asymmetry is what makes an IP allowlist placed *after* authentication useless for protecting the
  login route, which is itself `@Public()`.
- `RolesGuard` and `PermissionsGuard` share one body — `enforceRequiredClaim` in
  `libs/auth/guards/claim-guard.util.ts` — extracted so they cannot drift. It is **synchronous, pure,
  and reads only `request.user`**: no repository, no `await`, no access to the request body. It is also
  **disjunctive**: `required.some(v => claim.includes(v))`, so two codes on one route means *either*,
  not *both*.
- `@RequiresPermission` is a bare `SetMetadata` resolved with `getAllAndOverride([handler, class])`, so
  **handler metadata replaces class metadata rather than merging with it**, and the decorator carries no
  reference to the resource being acted on.

Those three properties of one small function decide the shape of four of the seven guides.

### What a request subject actually is

`ICurrentUser` is `{ id, email, roles, permissions }` and the access token adds only a `jti`. There is
no tenant, no scope, no authentication-strength claim and no attribute bag. Every generalising sketch in
this cluster has to widen that contract, and saying so plainly is more useful than any of the sketches'
own detail.

One further fact, verified because a sketch would otherwise have assumed the opposite: **the guards do
no I/O, but the request path is not I/O-free.** `JwtStrategy` resolves the subject through
`AUTH_USER_VALIDATOR`, and the bound `ValidateJwtSubjectUseCase` performs one existence check per
authenticated request (`existsActiveById` for staff, falling back to the customer repository). That
single hook is the only per-request place a revocation decision can be made, and two guides point at it.

---

## Where each sketch enters the guard chain

This is the cluster's central question and the place an authorization hole would hide. Two of the seven
answers are "nowhere", and both of those are the interesting ones.

| Guide | Enters the chain… | What it does to `@Public()` |
| --- | --- | --- |
| `sso-saml-oidc-federation.md` | **Before it.** The chain is untouched; what changes is how a subject is established before a session is minted. It adds new `@Public()` ACS/callback routes. | Adds public routes, which therefore need their own replay and relay-state protection — the chain gives them none. |
| `mfa-enforcement.md` | **Inside the login use case**, between password verification and token issuance. Optionally a **fourth** route-level check reading an authentication-strength claim, for step-up. | Unchanged. Enforcing by *not minting a session* means there is no session to guard. |
| `scoped-tenant-aware-roles.md` | **Inside `PermissionsGuard`** — the claim comparison gains a scope — plus the token shape and `ICurrentUser`. Scopes not present in the request move into the use case. | Unchanged. |
| `dynamic-abac-policies.md` | **A fourth stage after the existing three**, for subject/action/environment policies; **inside the use case** for anything that needs the resource loaded. | Unchanged; the coarse gates stay as a cheap pre-filter. |
| `approval-workflows.md` | **Nowhere.** It is a state machine in front of a use case. | Unchanged. |
| `session-device-management.md` | **In `ValidateJwtSubjectUseCase`**, where the existing per-request existence check becomes a session lookup. The IP allowlist runs **ahead of** `JwtAuthGuard`, in middleware or a guard that deliberately ignores the public opt-out. | The allowlist must **not** honour it — the route it most needs to cover is the public login route. |
| `staff-scheduling-and-shifts.md` | **Nowhere.** A separate deployable with its own routes; it needs new permission codes and nothing else. | Unchanged. |

**Why `approval-workflows.md` is deliberately not a guard.** A permission code answers *"may this
subject attempt this kind of action?"* — decided from a claim, before the request runs, about a person.
An approval answers *"has **this** attempt been agreed to?"* — about one request, usually by someone
else. A guard cannot answer the second: at the moment it runs there is no persisted attempt for an
approval to reference, and it has no way to know the approver is a different person from the requester,
which is the entire control. The guide states this in its Description rather than burying it, because
"check for an approval in a guard" is exactly the plausible-sounding sketch that would be wrong.

**The related conflation, stated once here and once in that guide.** The audit log's `action` column
holds `IAuditLogEvent.name` — an event name — and never a permission code. The names actually emitted
today are `UserLoggedIn`, `LoginFailed`, `LogoutPerformed`, `RefreshTokenRotated`, `RefreshFailed`,
`RefreshReuseDetected`, `StaffUserRegistered`, `StaffUserRolesAssigned`, `StaffUserRoleRevoked`,
`RoleCreated`, `RolePermissionsReplaced`, `CustomerRegistered`, `CustomerLoggedIn`,
`CustomerLoginFailed`, `CustomerErased`, `RefundIssued` and `RefundFailed`. Not one is a permission
code, and filtering the audit log by `order:refund` is a well-formed query that matches nothing.

---

## Codes versus roles versus policies

The registry is an enum today for four reasons, all of which are worth keeping in view before replacing
it:

1. **It is compile-time checked.** `@RequiresPermission(PermissionCodeEnum.ORDER_REFUND)` cannot
   reference a code that does not exist; a string could.
2. **It is exhaustively enumerable.** `Object.values(PermissionCodeEnum)` is what makes the `admin`
   bundle correct by construction rather than by maintenance.
3. **It is a single source of truth with a loud failure.** The seed throws by name when a member has no
   row, so the enum and the database cannot silently disagree.
4. **It costs nothing at request time.** The check is set membership against an array already in the
   token.

What each generalising sketch would replace, precisely:

| | What it changes | What survives | Decidable from the token alone? |
| --- | --- | --- | --- |
| **Scoped roles** | the **grant**: `staff_user_roles` widens from `(staffUserId, roleId)` to carry a scope; the claim carries scopes | the enum, the seed, every `@RequiresPermission` call site, the role bundles | **Yes** — both sides of the comparison are strings the request already has |
| **ABAC policies** | the **decision procedure**: set membership becomes rule evaluation over subject / resource / action / environment attributes | the enum, as the *action vocabulary* — a policy still has to name what is attempted | **No**, for the interesting cases — resource attributes require loading the resource |
| **Approval workflows** | **neither** — it adds a state machine in front of the use case, and one new code per approvable action for the approver | everything | n/a — it is not a request-time authorization decision at all |

The ordering that falls out of the table, and which both guides state: **do scoped roles first.** Most
requirements that sound like policies ("managers can only refund their own store's orders") are scope
requirements wearing a policy's clothes, and they are answerable inside the existing synchronous guard
at a fraction of the cost. ABAC earns its place when a requirement contains the word "unless", or a
number.

---

## The seven guides

### `sso-saml-oidc-federation.md` — `subsystem-scale (5+ capabilities)`

**Owns the staff login-path restructuring**, and the rest of the cluster attaches to the shape it
defines: `LoginUseCase` splits into *establish a subject* and *mint a session*, where the second half —
`jti` minting, `TOKEN_SERVICE`, refresh-hash rotation, `recordLoggedIn`, the audit event — is shared by
every authentication front-end. It owns that rather than the MFA guide because SSO *removes* credential
verification from this system, where MFA merely inserts a step into it; once the first half is
pluggable, a second factor is a stage, and the converse is not true.

Two `StaffUser` constructor invariants are the concrete friction and are named as such: the aggregate
rejects an empty `passwordHash` (a federated-only account has none) and an empty `roles` array (a
just-in-time-provisioned account must arrive with a role already resolved). The guide takes the same
fork the customer-side `social-login-providers.md` reaches from the other direction, and recommends the
model change over the placeholder hash for the same reason.

The hard rail it respects: **the identity provider's assertion never becomes the session token.** Every
guard reads `ICurrentUser` off our own JWT, and an external token carries none of it.

### `mfa-enforcement.md` — `2–3 capabilities`

Staff-side only. `mfa-and-household-grouping.md` owns the customer-facing story and states the boundary
in one sentence — *a customer **consents to** MFA; a staff member is **held to** it* — which this guide
quotes and does not re-argue. Everything here is about the direction of control: policy, mandate, grace
window, administrator-controlled recovery, step-up.

The finding that shaped it is a negative one. `ValidateJwtSubjectUseCase` looks like the obvious place
to reject a non-compliant staff member, and it is a trap: it runs on **every** authenticated request,
including the request to the enrolment endpoint, so a block there leaves the account permanently unable
to become compliant. Enforcing at login instead — by returning an enrolment challenge rather than a
token pair — needs no allowlist, because there is no session to guard.

The guide also argues for mandating by **permission code** rather than by role name, since a mandate
keyed on names silently fails to cover a fifth role added at runtime.

### `scoped-tenant-aware-roles.md` — `subsystem-scale (5+ capabilities)`

Cites the **Multi-tenancy** row in the root [`README.md` § Not built yet](../../../README.md#14-not-built-yet)
— linking the section, not restating the row.

Two pieces of existing groundwork bound it, and one domain invariant protects it. The cache-key
convention already reserves `t:<tenantId>`, opt-in and **never defaulted** — a single-tenant key carries
no tenant-shaped lie — and no key literal exists anywhere in `apps/`, so adopting the segment is a
change to builder callers rather than a hunt through string concatenation. The permission-code regex
forbids encoding a scope in the code string, which is the design that would have quietly destroyed the
registry. The scope therefore goes on the **grant**, and the permission vocabulary survives untouched.

The guide is explicit that a partial rollout is worse than none: a system where nine of ten read paths
are scoped is a system with one leak and a false sense of safety — which is also why the cache tenanting
and the authorization scoping have to land together.

### `dynamic-abac-policies.md` — `subsystem-scale (5+ capabilities)`

The distinction from scoped roles is stated from both sides — the grant side in that guide, the decision
side in this one — so neither is redundant and neither restates the other.

Its structural recommendation follows directly from `enforceRequiredClaim` being synchronous and pure:
**split enforcement by whether the resource has to be loaded.** Subject / action / environment policies
stay in the chain as a fourth stage; resource policies move into the use case, right after it loads the
aggregate. Attempting resource policies in a guard forces either a repository dependency inside
`libs/auth` or a second load of the same record.

Two smaller rails it carries: the condition is stored as a **structured typed expression**, not an
embedded scripting language (an engine evaluating administrator-supplied code is a remote-code-execution
surface with an approval workflow in front of it), and `deny` overrides `allow` with a default of deny —
both trivially adoptable at the start and painful to retrofit.

### `approval-workflows.md` — `2–3 capabilities`

Covered above: a state machine in front of a use case, and the guide most exposed to the code/action
conflation, which it addresses head-on.

The finding that changed its content is the **auto-refund path**. `IssueRefundUseCase` is reached both
from a staff route gated on `order:refund` and from the order-cancelled consumer with a **null actor** —
a system origin, audited as `staff` because the audit actor union has no `system` member. An approval
requirement applied indiscriminately would leave every cancellation's refund waiting for a human who
was never asked. So the rule has to distinguish human-initiated from system-initiated requests, and the
guide says so rather than leaving it to be discovered as a backlog.

Three things the refund path already provides, which is what keeps this at `2–3`: a required idempotency
key (so "approve, then execute" is safe rather than a second refund), an unconditional awaited audit
write, and a permission gate that already answers who may request.

One shape constraint the guide records: `AuditTargetKind` is a closed union of
`staff-user | customer | role | permission`. Nothing fits an order — which is why the refund audit
leaves `targetKind` null and puts the ids in the payload — and an approval request is in the same
position.

### `session-device-management.md` — `2–3 capabilities`

ADR-010 §3's rotation-with-reuse-detection design was verified before being described, and the
verification produced a correction worth recording: **it does not live in the token adapter.**
`JwtTokenAdapter` is a stateless signer — sign, verify, report an expiry — and holds no session state.
Rotation and the defensive hash-clear on mismatch are both in `RefreshTokenUseCase`.

The capability exists because of one column. `staff_user.refresh_token_hash` is a single nullable field
with a single mutator, so the system can represent **one session per subject**: a second login silently
invalidates the first device, and reuse detection signs the account out of everything it has. Replacing
the column with rows is the whole sketch, and it is cheaper than it looks — the `jti` a session would
key on is **already minted on every token and then thrown away**, persisted nowhere.

The privacy reconciliation the cluster demanded is here. An IP address and a device fingerprint are
personal data. They live on the **session row** — operational state, visible to the person they
describe, deleted with the session or at a retention horizon — and **not** in event payloads or audit
rows, which [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) §4 keeps free of PII
precisely because those logs are the durable, replicated surface an erase cannot reach. The audit wire
shape already carries an `ipAddress` field that the shared mapper **hardcodes to `null`**, because no
call site anywhere captures a request address; filling it is a decision with a cost, not an obvious
improvement, and the guide says so.

The IP-allowlist placement is a wiring constraint rather than a preference: the rule must cover the
login route, the login route is `@Public()`, and `@Public()` short-circuits `JwtAuthGuard` — so a check
placed after it never sees the request it most needs to see.

### `staff-scheduling-and-shifts.md` — `subsystem-scale (5+ capabilities)`

The cluster's outlier: it changes no authorization behaviour and instead builds a neighbouring bounded
context in a **new deployable** — the seventh, following the six existing ones' layout, transport and
tracer-first boot.

Its entire design rests on what `StaffUser` is: an authentication principal with an email, a password
hash, roles, an `active | suspended` status, a last-login timestamp and a refresh-token hash. **It
carries no person** — no legal name, no employment dates, no contract hours, no manager. The tempting
move is to add them; the guide argues against it on lifecycle grounds (an account is disabled the day
access ends; the employment record outlives it for years of statutory retention) and on privacy grounds
(an employment record is dense personal data, and absence reasons can imply health information). The
context therefore stores a `staffUserId` and nothing else about identity, with **no** foreign key across
the boundary, and its own database on the precedent the event store set.

It also notes that `status` is an **access** state, not an employment one — a suspended account may
belong to someone on leave, someone who left, or someone compromised this morning — and that `suspend()`
has no caller today, which the root `README.md` §14 records as the staff-deactivation gap.

---

## What was verified, and how

Everything in the guides that names a path, a symbol, a token, a column, a regex or a count was read out
of the source in the same session that wrote it. The commands below reproduce the checks:

```bash
# the registry, the seeded bundles, the guard order
cat libs/contracts/auth/permission.enum.ts
grep -n "PERMISSION_SEEDS\|ROLE_SEEDS\|permissions:" scripts/test-db-seed.ts
grep -rn "APP_GUARD" apps/api-gateway/src --include=*.ts

# the decision procedure and the decorator behind it
cat libs/auth/guards/claim-guard.util.ts libs/auth/decorators/requires-permission.decorator.ts

# the aggregates, the ports, and the token shape
cat apps/api-gateway/src/modules/auth/domain/staff-user.model.ts
cat apps/api-gateway/src/modules/auth/domain/role.aggregate.ts
cat apps/api-gateway/src/modules/auth/domain/permission.aggregate.ts
cat libs/contracts/auth/jwt-payload.dto.ts libs/contracts/auth/current-user.dto.ts

# the audit contract, and the claim that its ipAddress is always null
cat libs/contracts/auth/audit-log-publisher.port.ts libs/contracts/auth/audit-staff-action.event.ts
grep -rn "\.ip\b\|x-forwarded-for" apps libs --include=*.ts      # no matches — nothing captures one

# the jti is minted and never persisted
grep -rn "jti" apps libs --include=*.ts | grep -v spec

# the guide contract
npx jest --config jest.unit.config.js -i spec/extension-guides.spec.ts
```

`docs/extensions/` now holds `README.md` plus **63** guides — the whole registry bar the Physical Retail
entry.

## Related reading

- [ADR-055](../../adr/055-where-deliberately-unbuilt-work-is-recorded.md) — the three places deliberately
  unbuilt work is recorded, and why a guide is not an obligation.
- [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md) — the JWT chain, argon2 choice, and the
  rotation-with-reuse-detection design (its RBAC model is superseded; §3 is live).
- [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) — the `StaffUser`/`Customer`
  split, the relational role/permission model, and the three-guard composition.
- [ADR-047](../../adr/047-staff-user-creation-over-http.md) — why minting a principal has its own
  permission code, and the standing rule that a new code must also be seeded.
- [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) — the privacy rail: no PII in an
  event payload or an audit row.
- [`08-notifications-and-events-extension-guides.md`](08-notifications-and-events-extension-guides.md) —
  the preceding cluster.
