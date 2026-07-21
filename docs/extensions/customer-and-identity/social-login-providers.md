---
title: Social login providers
cluster: Customer & Identity
effort: 2–3 capabilities
attaches_to:
  - libs/auth/
  - apps/api-gateway/src/modules/auth/application/ports/
---

# Social login providers

## Description

Social login lets a customer sign in with Google, Apple or Facebook instead of an email-and-password
pair. The external identity provider (IdP) vouches for who they are over OAuth 2.0 / OpenID Connect, and
the shop mints its **own** session on the strength of that vouching. Saleor, Vendure and commercetools all
support this as an alternative *authentication front-end* that leaves the rest of the identity model
untouched: the customer is still a `Customer`, the session is still the same JWT.

## Business needs

- **Reduced sign-up friction** — one tap with an existing Google account converts better than a
  registration form.
- **No password to manage** — a customer who never sets a password is a customer whose credentials the
  shop never has to store or reset.
- **Enterprise SSO adjacency** — a consumer social login and a staff-side SAML/OIDC federation are the same
  token-exchange shape pointed at different providers.
- The threshold: a shop whose customers happily register with email never needs this; the first "Sign in
  with Google" button is where an external-IdP credential path has to exist alongside the password one.

## Attachment points in the current core

- **`libs/auth/`** — the guard chain and JWT strategy. `JwtStrategy` validates the bearer token and
  resolves the principal through `AUTH_USER_VALIDATOR`; the three global guards
  (`JwtAuthGuard → RolesGuard → PermissionsGuard`) gate every route. Social login changes **none** of
  this — it changes only how the token is *first obtained*. The JWT chain itself is out of scope here; it
  is decided in [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md) and this guide does not restate it.
- **The auth ports at `apps/api-gateway/src/modules/auth/application/ports/`.** Today a `Customer`
  authenticates through two seams: `PASSWORD_HASHER` (`IPasswordPort` — `hash` / `verify`) checks the
  credential, and `TOKEN_SERVICE` (`ITokenPort` — `issueAccessToken` / `issueRefreshToken`) mints the
  session. Social login **replaces the first seam and reuses the second unchanged**: an IdP token exchange
  stands in for `PASSWORD_HASHER.verify`, and `TOKEN_SERVICE` issues the identical access/refresh pair, so
  everything downstream of the session is oblivious to how the customer proved themselves.
- **`Customer.passwordHash` is already nullable — but the model invariant blocks a social-only *active*
  customer.** `passwordHash` may be null only for `status = 'guest'` or `'deleted'`; an `active` customer
  must carry a hash. A social-only customer has no password, so this invariant is the real attachment
  friction, and the open questions below turn on it.

## Implementation sketch

- **A `FederatedIdentity` link** — `(provider, providerSubject) → customerId`, so one customer can link
  several providers (Google *and* Apple) and a returning social login resolves to the existing `Customer`
  rather than creating a duplicate. This is the new persistence the capability adds.
- **A `LoginWithProvider` use case** beside the existing `LoginCustomerUseCase`: it takes the IdP's
  authorization code, exchanges it through a **provider adapter** (the port-and-adapter shape, one adapter
  per provider, HTTP confined to infrastructure), verifies the returned identity token, looks up or
  provisions the `FederatedIdentity` + `Customer`, then calls `TOKEN_SERVICE` to mint the session — reusing
  the refresh-hash rotation `LoginCustomerUseCase` already does.
- **The invariant call.** Either relax the `Customer` invariant so an `active` customer may have a null
  `passwordHash` **when a `FederatedIdentity` exists** (the cleaner model — a customer is authenticatable if
  they have *a* credential, password or federated), or keep the invariant and require every social customer
  to also set a password (worse UX). The guide surfaces this as the load-bearing decision, not a detail.
- **Erasure.** A `FederatedIdentity` row carries the provider's `providerSubject` — an external identifier
  *for the person*, so it is PII-adjacent. On tombstone erase it is **nulled/dropped** alongside the
  `Customer` PII and the `refreshTokenHash` the erase already clears (ADR-037 §2), severing the link to the
  external identity.
- **Events** — reuse the existing `CustomerRegisteredEvent` domain event for a first-time social sign-up;
  no new transport, no PII beyond what that event already defines. No new wire event is required.
- **Config** arrives through DI value-provider tokens (client ids/secrets per provider), never
  `process.env` in a use case — the established config-through-a-token convention.

## Open design questions

- **The null-password invariant** (above) — relax it for federated customers, or force a password anyway.
  Everything else is downstream of this.
- **Account linking and collision** — a social login whose email matches an existing password account:
  auto-link (convenient, a known account-takeover vector) or force an explicit link-while-authenticated
  flow (safe, more friction)?
- **Which provider claims to trust** — email-verified from the IdP vs. re-verify; whether the provider's
  email is authoritative for `Customer.email` or merely a hint.
- **Token storage** — does the shop store the IdP refresh token to call provider APIs later, or discard it
  after the one-time identity exchange? Storing it is more capability and more liability.

## Effort sketch

`2–3 capabilities` — the `FederatedIdentity` link, the per-provider token-exchange adapter, and the
`LoginWithProvider` use case, plus the invariant relaxation. It is bounded **because** it reuses
`TOKEN_SERVICE` and the entire guard chain untouched; only the credential-verification step is new.
