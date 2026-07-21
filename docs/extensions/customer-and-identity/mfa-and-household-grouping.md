---
title: Customer MFA and household grouping
cluster: Customer & Identity
effort: 2–3 capabilities
attaches_to:
  - apps/api-gateway/src/modules/auth/application/use-cases/
  - apps/api-gateway/src/modules/auth/domain/customer.model.ts
---

# Customer MFA and household grouping

## Description

Two customer-account-management capabilities that both extend the `Customer` party without touching the
money path, and both are **opt-in by the customer**. **Multi-factor authentication (MFA)** adds a second
factor — a TOTP authenticator or an SMS code — on top of the password login. **Household grouping** links
several customers into one household so they can share an address book, a subscription, or a loyalty
balance. They are bundled because they are the same kind of change: a self-service facet a customer adds
to their own account, opting in, and removable by the customer at will.

This guide **owns the customer-facing MFA story.** A separate staff-side mfa-enforcement capability
(Staff & Access Control) is the *mandated* counterpart, and the boundary between them is stated below so
the staff-side guide can quote it rather than re-argue it.

## Business needs

- **Account security** — a customer with saved payment methods and an order history wants a second factor
  guarding their account.
- **Shared accounts** — families, couples and shared subscriptions want one household with several
  sign-ins, a shared address book, and one loyalty balance rather than duplicate accounts.
- **Recovery** — a customer who loses their second factor needs backup codes, which is itself part of the
  MFA capability, not an afterthought.
- The threshold: a low-value guest-heavy shop never needs either; the first customer who asks "can I
  turn on two-factor?" or "can my partner use our account?" is where these attach.

## Attachment points in the current core

- **The login use cases at `apps/api-gateway/src/modules/auth/application/use-cases/`.** MFA **wraps**
  `LoginCustomerUseCase`. Today that use case runs `findByEmail → validatePassword → issue access+refresh
  → rotate refresh hash → recordLoggedIn → save`. MFA inserts a gate **between** a successful
  `validatePassword` and the token issuance: if the customer is enrolled, no session is minted yet — a
  second-factor challenge is required, and only on success does `TOKEN_SERVICE` issue the pair. The rest of
  the login (refresh-hash rotation, audit) is unchanged. The JWT chain itself is
  [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md) and is not restated here.
- **The `Customer` aggregate at
  `apps/api-gateway/src/modules/auth/domain/customer.model.ts`.** `Customer` already carries a
  `refreshTokenHash` that `erase()` clears as a session revocation — MFA's stored secret joins that set of
  security material the tombstone erase must null. Household grouping links several `Customer` ids; the
  party is the anchor for both.

## Implementation sketch

### The customer / staff MFA boundary (owned here, quoted by the staff-side guide)

- **Customer MFA is opt-in self-service.** The customer chooses to enrol, manages their own recovery
  codes, may "remember this device", and may disenrol. There is **no mandate** — a customer who declines
  MFA still logs in with a password. Consent to enrol is the whole control model.
- **Staff MFA (the staff-side enforcement guide) is policy-driven compliance.** An organisation or a role
  *mandates* it: an admin can require every staff member in a role to enrol, disenrolment is **not** the
  staff member's choice, and a non-compliant staff account is blocked until it enrols. Same TOTP primitive,
  opposite direction of control — a customer *consents to* MFA; a staff member is *held to* it.
- Both share the underlying second-factor mechanism; they differ entirely in **who decides**. That single
  sentence is the line the staff-side guide inherits.

### MFA

- **A `CustomerMfaEnrollment`** (1:1 with `Customer`) holding the TOTP secret or the verified phone, plus a
  set of one-time **backup codes**. The secret and phone are **secrets/PII** — on tombstone erase they are
  nulled alongside `refreshTokenHash` (ADR-037 §2). A challenge-issued interim `mfa_pending` state lives
  between password success and token issuance and never becomes a session.
- **Config** (issuer name, code TTL, SMS provider credentials) arrives via DI value-provider tokens, never
  `process.env` in a use case.

### Household grouping

- **A `Household` grouping** owning member `Customer` ids — a loose consumer-side link, **distinct** from
  the B2B company hierarchy (that is an org with credit terms and a materialized-path tree; a household is
  a flat set of individuals sharing benefits). Membership rows are `(householdId, customerId)` — id-keyed,
  no PII.
- **Shared facets** (address book, a shared loyalty balance, a shared subscription) are reads scoped to the
  household rather than the individual — each shared facet is a small integration with the owning
  capability, not new state here.
- **Erasure** removes a customer from their household (an id-keyed membership row, dropped), and any shared
  benefit re-derives over the remaining members.
- **Events** ride `ris.events` if added — `customer.household.member-added` / `.removed`, ids only, no PII.

## Open design questions

- **MFA method priority** — TOTP-only (no telephony dependency, worse recovery) vs. SMS (better UX, an SMS
  provider dependency and SIM-swap risk) vs. both with a primary/fallback.
- **Remember-this-device** — a trusted-device token that skips the challenge for N days is a second
  long-lived credential with its own revocation and its own erasure obligation.
- **Household authority** — is there a household "owner" who can add/remove members, or is membership
  symmetric? An owner model starts to resemble a tiny RBAC.
- **Shared vs. personal data in a household** — a shared address book is convenient but crosses one
  customer's PII into another's view; consent for that sharing is a genuine privacy question, not a UX one.

## Effort sketch

`2–3 capabilities` — the challenge-wrapped login with `CustomerMfaEnrollment` and backup codes, and the
`Household` grouping with its shared-facet reads. Two capabilities that share the `Customer` party and the
login seam but are otherwise independent.
