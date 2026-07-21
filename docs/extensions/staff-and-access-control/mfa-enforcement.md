---
title: Staff MFA enforcement
cluster: Staff & Access Control
effort: 2–3 capabilities
attaches_to:
  - apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts
  - apps/api-gateway/src/modules/auth/domain/staff-user.model.ts
---

# Staff MFA enforcement

## Description

**Staff MFA enforcement** is the policy machinery that makes a second factor *mandatory* for people who
operate the shop: requiring enrolment for everyone holding a given role, blocking a non-compliant
account until it enrols, giving an administrator a recovery path when a factor is lost, and demanding a
fresh factor before an especially destructive action.

The second factor itself — TOTP, backup codes, the challenge that sits between a verified password and
an issued session — is **owned by
[`mfa-and-household-grouping.md`](../customer-and-identity/mfa-and-household-grouping.md)** and is not re-described here. That
guide states the boundary this one inherits, in one sentence: *a customer **consents to** MFA; a staff
member is **held to** it.* Same primitive, opposite direction of control. Everything below is about the
direction, not the primitive.

That difference is not a nuance, it is the whole capability. A customer who declines MFA still logs in;
declining is a legitimate outcome the system must support. A staff member who declines must not be able
to do their job, which means enrolment has to be enforceable at a moment when they are trying to work —
and that moment is inconveniently the same moment at which they are least able to complete it. A
customer who loses their phone can be walked through a self-service recovery flow at leisure; a
warehouse supervisor who loses theirs at the start of a shift needs an administrator with the authority
to restore access and an audit record proving that authority was used.

The login-path restructuring this attaches to is owned by
[`sso-saml-oidc-federation.md`](sso-saml-oidc-federation.md): once establishing a subject is a pipeline
separate from minting a session, the second factor is a stage in the first half. Under federation the
factor often moves to the identity provider entirely, and this capability becomes *verifying* an
assertion's authentication-method claim rather than performing a challenge.

## Business needs

- **Staff credentials are the high-value target** — a compromised warehouse account moves inventory; a
  compromised support account issues refunds. The blast radius of a staff password is the shop's money
  and stock, not one person's order history.
- **Compliance frameworks assume it** — PCI DSS, SOC 2 and most cyber-insurance questionnaires ask
  whether administrative access requires multi-factor authentication, and "it is available if staff
  choose to enable it" is a failing answer.
- **Phishing is aimed at staff** — a support agent is a named, findable, socially engineerable target in
  a way a random customer is not.
- **Shared workstations** — a warehouse terminal used by a shift has weaker physical separation than a
  personal device, and a second factor is what re-personalises a session.
- The threshold: a single-operator shop with one login gains little. The first time a second person is
  given a staff account — particularly one holding `order:refund` or any `iam:` code — is where a
  mandate starts paying for itself.

## Attachment points in the current core

- **`LoginUseCase` at
  `apps/api-gateway/src/modules/auth/application/use-cases/login.use-case.ts` — the enforcement point,
  and the reason it is the right one.** The use case verifies the password and then, unconditionally,
  mints an access token, mints a refresh token, rotates the refresh hash, records the login and audits
  it. A mandate is enforced by **not reaching that half**: a non-compliant account gets an enrolment
  challenge instead of a token pair, exactly as the customer-side flow gets a factor challenge. Nothing
  downstream needs a new guard, because there is no session to guard.
- **Why enforcement must *not* live in `ValidateJwtSubjectUseCase`.** That use case runs on every
  authenticated request and throws `UnauthorizedException` when the subject is no longer active — an
  obvious-looking place to reject an unenrolled staff member. It is a trap: it would also reject the
  request to *the enrolment endpoint*, leaving the account permanently unable to become compliant. Any
  block applied after a session exists needs an explicit allowlist; a block applied before one is
  issued needs none.
- **`StaffUser` at `apps/api-gateway/src/modules/auth/domain/staff-user.model.ts`.** The aggregate holds
  `roles`, a `status` of `active | suspended`, `lastLoginAt` and a single `refreshTokenHash`. It has no
  concept of authentication strength, which is precisely the gap: enrolment state is new state on (or
  beside) this aggregate, and `isActive` — today `status === 'active' && deletedAt === null` — is the
  existing shape a compliance predicate would join.
- **The role is the natural unit of mandate.** `StaffUser.roles` is a set of `RoleAggregate`s and
  `permissionCodes` is their deduped union, so "every role that grants `order:refund` requires MFA" is
  expressible without new plumbing. Mandating by **permission code** rather than by role name is the
  more durable phrasing, because a mandate keyed on a role name silently fails to cover a fifth role
  added at runtime — and [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) is explicit
  that the four seeded names are the floor, not the ceiling.
- **The audit seam.** `LoginUseCase` already publishes `UserLoggedIn` and `LoginFailed` through
  `AUDIT_LOG_PUBLISHER`, and the enforcement events belong in the same stream. Their `action` values are
  event names — `MfaEnrolmentRequired`, `MfaChallengeFailed`, `MfaResetByAdmin` — and never a permission
  code; that column is a classifier of *what happened*, not of *what was allowed*.
- **No secret goes in an audit payload or an event.** A TOTP secret, a backup code and a delivered
  one-time code are all credential material, and the durable, replicated audit log is the last place any
  of them may land ([ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) §4). The audit records
  that a challenge happened and how it resolved.

## Implementation sketch

- **An `MfaPolicy` expressed over permission codes, evaluated at login.** A small rule set — "these
  codes require a second factor", plus a global "all staff" switch — resolved against the user's
  `permissionCodes` union. Configuration arrives through a DI value-provider token or a table, never
  `process.env` read inside a use case.
- **Three outcomes from a successful password check**, replacing today's single one: issue the session
  (compliant), issue a factor challenge (enrolled, not yet verified), or issue an **enrolment** challenge
  (mandated, not enrolled). Only the first mints tokens. The interim state is short-lived, single-use
  and never a session — the same discipline the customer-side flow uses for its pending state.
- **A grace window, deliberately bounded.** Turning a mandate on with no grace locks out every existing
  staff member at once, including whoever would fix it. A first-login grace period, or a deadline after
  which the mandate hardens, is the difference between a rollout and an incident — and it is a policy
  field, not a deploy-time constant.
- **Administrator-controlled recovery, gated by its own permission code.** Resetting another person's
  second factor is a privilege at least as high as assigning them a role, and by the reasoning
  [ADR-047](../../adr/047-staff-user-creation-over-http.md) applied to staff creation it deserves its own
  code rather than borrowing `iam:assign` — otherwise every operator who can grant a role can also
  bypass a factor. A new code is not live until it is also added to the seed's permission list, which is
  a real coupling: an enum member with no seeded row reaches no role at all, including `admin`.
- **Step-up authentication as the optional third capability.** Some actions — issuing a refund, editing
  a role — warrant a fresh factor even inside a valid session. That requires the access token to carry
  *when* and *how strongly* the subject authenticated, which today it does not: the payload is `sub`,
  `email`, `roles`, `permissions` and a `jti`. Adding an authentication-method claim is a token-shape
  change, and enforcing it is a route-level decorator that reads the claim — a fourth check the guard
  chain can host without disturbing the existing three.
- **Enrolment state is security material with an erasure obligation.** A staff member is not a
  `Customer` and the tombstone-erasure flow does not reach them, but the secret is still a credential:
  it is cleared when the account is suspended, and cleared alongside `refreshTokenHash` whenever
  sessions are invalidated.
- **Events** ride `ris.events` (`auth.staff.mfa-enrolled`, `auth.staff.mfa-reset`) with ids only.
- **Shared types** (the policy view, the enrolment status projection) under `libs/contracts/<cluster>/`.

## Open design questions

- **Whether the mandate keys on roles or on permission codes.** Codes survive a fifth role; role names
  are what an administrator actually thinks in. A UI over codes that displays affected roles is the
  usual compromise, and it is more work than either.
- **What happens to live sessions when a mandate is turned on.** Enforcing only at login means an
  already-authenticated non-compliant user keeps working until their refresh token expires — up to the
  refresh lifetime. Enforcing immediately requires a session-level revocation channel, which is
  [`session-device-management.md`](session-device-management.md)'s subject.
- **Backup codes versus administrator reset.** Self-service codes reduce administrative load and are a
  second credential to store and to leak; administrator reset centralises trust and makes an
  administrator a phishing target for social engineering ("I've lost my phone").
- **The last-administrator problem.** A mandate that locks out every account holding `iam:role-edit` is
  unrecoverable without database access, and it mirrors an invariant the aggregate already enforces
  elsewhere — `revokeRole` refuses to remove a staff member's last remaining role for the same class of
  reason.
- **Whether federation subsumes this.** When an identity provider performs MFA, this system should
  *verify* the assertion's authentication-method claim rather than run its own challenge — which is a
  different capability wearing the same name, and mixing the two produces a double prompt.
- **Shared-workstation ergonomics.** A factor prompt on every login is unusable on a warehouse terminal
  where a shift logs in repeatedly; device trust is the usual mitigation and is another long-lived
  credential with its own revocation problem.

## Effort sketch

`2–3 capabilities` — a policy model evaluated at login, the three-way login outcome with an enrolment
challenge and a bounded grace window, and administrator-controlled recovery behind its own permission
code. Optional step-up authentication is the third and is genuinely separable. It stays bounded
**because** the second-factor primitive, its storage and its recovery codes are inherited from the
customer-side guide rather than re-designed, the login use case is already the single choke point for
session minting, and the audit seam takes the new events unchanged. What is genuinely new is *policy* —
and policy is where the expensive mistakes are, because every one of them is either a lockout or a hole.
