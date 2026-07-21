---
title: SSO, SAML and OIDC federation
cluster: Staff & Access Control
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - libs/auth/jwt.strategy.ts
  - apps/api-gateway/src/modules/auth/application/ports/token.port.ts
  - apps/api-gateway/src/modules/auth/domain/staff-user.model.ts
---

# SSO, SAML and OIDC federation

## Description

**Single sign-on** lets a staff member authenticate against their employer's identity provider — Okta,
Entra ID, Google Workspace, a SAML 2.0 IdP — instead of against a password stored here. The organisation
keeps one directory, one password policy and one offboarding switch; this system stops being a place
where employment status is separately maintained and starts being a place that *trusts* an assertion.

**This guide owns the login-path restructuring for staff**, and the other guides in this cluster attach
to the shape it defines. The reason it owns it rather than
[`mfa-enforcement.md`](mfa-enforcement.md) is that SSO is the more radical of the two changes: MFA
inserts a step into credential verification, whereas SSO *removes* credential verification from this
system entirely and replaces it with a signed assertion from somewhere else. Once the login use case is
a pipeline whose first stage is pluggable, adding a second factor is a stage; the reverse is not true.

The customer-facing counterpart —
[`social-login-providers.md`](social-login-providers.md) — is a different problem despite the shared
protocol vocabulary. There, a consumer picks a provider and links it to their own account. Here, an
*organisation* mandates a provider for everyone in it, provisions and deprovisions accounts through it,
and expects the shop to have no independent notion of who works there. That guide owns the
customer-side token exchange and the `FederatedIdentity` link; this one owns the enterprise story and
does not restate it.

## Business needs

- **Offboarding must be one action** — a staff member who leaves loses access when their directory
  account is disabled, not when someone remembers to open the admin UI here. This is the single most
  common reason SSO is a procurement requirement.
- **Password policy belongs to the employer** — rotation, complexity and lockout rules are already
  enforced centrally, and a second independent password is a second thing to attack.
- **Enterprise buyers require it** — SAML SSO is on nearly every mid-market and enterprise procurement
  checklist, frequently as a hard gate rather than a preference.
- **Onboarding cost** — just-in-time provisioning means a new warehouse hire in the directory's
  `warehouse` group can log in on day one without anyone minting an account.
- **Audit and compliance** — a central directory gives one authoritative answer to "who had access on
  this date", which a per-application user table cannot.
- The threshold: an owner-operated shop with four staff logins needs none of this. The first customer
  whose IT department asks for a SAML metadata URL is the trigger, and the second one — with a
  *different* IdP — is what turns it from an integration into a subsystem.

## Attachment points in the current core

- **`LoginUseCase` at
  `apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts` — and the exact line
  where federation cuts in.** It runs, in order: `findByEmail` → `user.isActive` check →
  `validatePassword(hasher)` → mint an access `jti` and a refresh `jti` → `issueAccessToken({ sub,
  email, roles, permissions, jti })` → `issueRefreshToken` → `rotateRefreshTokenHash(hash(refreshToken))`
  → `recordLoggedIn()` → `save` → publish a `UserLoggedIn` audit event. **Only the first three steps
  are about credentials.** Everything from `jti` onward is about minting *our* session and is reusable
  verbatim, which is what keeps this bounded despite its size.
- **`TOKEN_SERVICE` (`ITokenPort`) at
  `apps/api-gateway/src/modules/auth/application/ports/token.port.ts` — the seam that must not move.**
  It issues an access token and a refresh token and verifies a refresh token. **The IdP's assertion
  never becomes the session token.** Every guard in the system reads `ICurrentUser` — `{ id, email,
  roles, permissions }` — off our own JWT, and an external token carries none of that. Federation
  changes how we come to believe a subject's identity; it must not change what we put on the wire.
- **`JwtStrategy` at `libs/auth/jwt.strategy.ts` and the `AUTH_USER_VALIDATOR` seam.** The strategy
  verifies our JWT's signature and expiry, then defers to a host-app validator so `libs/auth` never
  learns how accounts are stored or revoked. That indirection already exists and is exactly the hook a
  federated deployment needs: the validator, not the strategy, is where "is this subject still
  employed?" can be asked.
- **`StaffUser` at `apps/api-gateway/src/modules/auth/domain/staff-user.model.ts` — two constructor
  invariants that a federated account trips.** The aggregate rejects an empty `passwordHash`
  *and* an empty `roles` array. A staff member who only ever logs in through an IdP has no password at
  all, and a just-in-time-provisioned account must arrive with at least one role already resolved. These
  are the two concrete model decisions this capability forces, and they are stated as invariants in the
  domain rather than as column constraints, so relaxing them is a domain change.
- **Role binding is data, not an enum.** `RoleEnum` is a typed registry of the four seeded role names;
  the runtime-of-record is the `role` table, and admin tooling may introduce a fifth name at runtime
  ([ADR-024](../adr/024-rbac-v2-staffuser-customer-and-permissions.md)). An IdP-group→role mapping is
  therefore configuration over rows, not a code change — the mapping table is the natural place for it.
- **`POST /api/iam/staff` and `RegisterStaffUserUseCase`** — the existing, permission-gated way a
  principal is minted ([ADR-047](../adr/047-staff-user-creation-over-http.md)). Just-in-time
  provisioning is that use case with an assertion as its authorisation instead of an `iam:staff-create`
  claim, which is precisely why it deserves scrutiny rather than reuse-by-default.
- **`/auth/staff/login` is `@Public()`.** The guard chain already tolerates unauthenticated routes, so
  the ACS / callback endpoints federation adds are not a new kind of exception — they are more of an
  existing one, and they need their own protection (relay-state validation, replay windows) precisely
  because the guard chain gives them none.

## Implementation sketch

- **Split `LoginUseCase` into two stages: *establish a subject* and *mint a session*.** The second
  stage — jti minting, `TOKEN_SERVICE`, refresh-hash rotation, `recordLoggedIn`, the audit event — is
  extracted once and shared by every authentication front-end. This is the structural change the whole
  cluster inherits, and doing it first is what makes MFA a stage rather than a rewrite.
- **An `IdentityProvider` aggregate**: issuer, protocol (SAML 2.0 or OIDC), signing certificate or JWKS
  endpoint, ACS/redirect URLs, an email-domain claim, an active flag, and the group→role mapping. It is
  configuration with a lifecycle — certificates rotate, and a rotation with no overlap window is an
  outage for a whole organisation.
- **One protocol adapter per protocol, behind a port.** SAML's XML signature validation and OIDC's
  code exchange are entirely different mechanics with the same output: a verified assertion carrying a
  subject identifier, an email and group memberships. HTTP and XML parsing stay in
  `infrastructure/`; the use case sees the verified assertion only.
- **A `FederatedStaffIdentity` link** — `(providerId, providerSubject) → staffUserId`. Key on the
  provider's stable subject identifier, **not** on the email address: emails get reassigned when people
  change name or when a departing employee's address is handed to their replacement, and keying on
  email silently grants the successor the predecessor's session history.
- **Resolve the `passwordHash` invariant explicitly, and prefer the model change.** Either the
  aggregate admits a null hash when a federated identity exists — an authentication-method invariant
  rather than a password one — or a placeholder hash is stored. The placeholder is the cheaper edit
  and the worse model: it makes a password-authenticable-looking account that no password opens, and
  every future reader has to rediscover why. The customer-side guide reaches the same fork from the
  other direction.
- **Just-in-time provisioning with an explicit default.** A first-time assertion creates the
  `StaffUser`, but `roles` cannot be empty, so the mapping must yield at least one role — either from a
  group claim or from a configured per-provider default. A default of "no access beyond login" is
  safer than a default of "whatever the last mapping said", and an unmapped group must fail closed.
- **Deprovisioning is the requirement, not a nicety.** The offboarding promise is only real if
  disabling the directory account ends access here. Three mechanisms, in increasing order of honesty:
  the access token's short lifetime, the per-request active-subject check the JWT validator already
  performs, and a directory-push protocol (SCIM) that suspends the account. `StaffUser.suspend()`
  exists and no production path calls it — only the unit suite does — which is the gap the root
  [`README.md` § Not built yet](../../README.md#14-not-built-yet) records for staff deactivation.
- **Keep a break-glass local login.** An IdP outage with no local path is a total lockout of the
  administration surface. At least one local administrator account, explicitly marked and audited on
  every use, is the standard answer.
- **Audit every federated login and every provisioning decision.** These ride the existing staff-action
  seam; the `action` string is an event name such as `FederatedLoginSucceeded` or
  `StaffUserProvisionedFromIdp`, **never** a permission code. No assertion body is stored — it is a
  signed document full of directory attributes, which is exactly the class of data the privacy rail
  ([ADR-037](../adr/037-consent-record-and-tombstone-erasure.md)) keeps out of durable log rows.
- **Events** ride `ris.events` with dotted keys (`auth.staff.federated-login`), ids only.
- **Shared types** (the provider view, the assertion projection) under `libs/contracts/<cluster>/`.

## Open design questions

- **One IdP or many.** A single-organisation deployment can hardcode one provider; a multi-organisation
  one needs provider selection before authentication, which means home-realm discovery by email domain
  — and an email domain is a weak, spoofable routing key until the assertion is verified.
- **Whether groups map to roles or to permission codes.** Mapping to roles keeps the existing bundle
  abstraction and lets an IdP admin think in job titles; mapping to codes is finer but re-creates the
  problem the role table exists to solve.
- **Whether directory roles are authoritative on every login.** Re-syncing roles from group claims at
  each login makes the directory the source of truth and silently discards any local grant; not
  re-syncing means a promotion in the directory never arrives. Both are defensible; drifting between
  them is not.
- **SCIM provisioning as a separate capability.** Push-based user lifecycle is a second protocol, a
  second authenticated inbound surface, and arguably its own guide-sized piece of work.
- **Session lifetime under federation.** IdPs express their own session policies (max age, forced
  re-authentication), and honouring them requires either short tokens plus silent re-authentication or
  a session record that can be revoked — the state
  [`session-device-management.md`](session-device-management.md) proposes.
- **What "active" means when two systems both claim to know.** A locally suspended but
  directory-enabled account, and the reverse, are both reachable states; which one wins has to be a
  decision rather than an accident of ordering.

## Effort sketch

`subsystem-scale (5+ capabilities)` — the login-pipeline split, an `IdentityProvider` aggregate with
certificate rotation, a SAML adapter, an OIDC adapter, just-in-time provisioning with group mapping,
deprovisioning, and the administrative surface to configure and test a connection. Reuse is real —
`TOKEN_SERVICE`, the guard chain, `ICurrentUser` and the audit seam are all untouched — but the
protocols are unforgiving (XML signature validation is a well-known source of authentication bypasses),
each provider has its own dialect, and the failure mode of getting it wrong is not a bug report but an
authentication hole. The cost that is easy to underestimate is that every enterprise customer's IdP is
configured slightly differently, so this capability never quite stops being worked on.
