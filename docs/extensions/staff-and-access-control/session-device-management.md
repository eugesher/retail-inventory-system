---
title: Session and device management, IP allowlists
cluster: Staff & Access Control
effort: 2–3 capabilities
attaches_to:
  - apps/api-gateway/src/modules/auth/application/use-cases/refresh-token.use-case.ts
  - apps/api-gateway/src/modules/auth/application/use-cases/validate-jwt-subject.use-case.ts
---

# Session and device management, IP allowlists

## Description

**Session management** turns "logged in" from an implicit consequence of holding a token into a record
somebody can look at and act on: which devices a staff member is signed in on, from where, since when —
and a button that ends one of them. **IP allowlisting** is the adjacent control that restricts where
administrative access may originate at all.

The reason this is a capability rather than a setting is a single column. Authentication persists
exactly one `refresh_token_hash` per subject, so **the system can represent one session per person and
no more**. A second login does not create a second session; it overwrites the first, and the first
device silently stops being able to refresh. Everything below follows from replacing that column with
rows.

## Business needs

- **Offboarding and incident response** — "revoke every session for this account, now" is the first
  thing asked during a suspected compromise, and it is currently answerable only by waiting for tokens
  to expire.
- **Shared and physical devices** — a warehouse terminal or a shop-floor tablet stays signed in; knowing
  which devices hold a live session, and being able to end one remotely when a device is lost, is an
  operational necessity rather than a nicety.
- **Visibility as a control** — a staff member who can see an unfamiliar sign-in is a detection
  mechanism that costs nothing to run.
- **Administrative surface restriction** — for many organisations, "the admin panel is reachable only
  from the office network or the VPN" is a compliance requirement, and it is enforced far more cheaply
  than it is argued about.
- **Session policy** — an idle timeout on an account that can issue refunds is a different requirement
  from one on a customer account, and today both inherit the same token lifetimes.
- The threshold: a single operator on one laptop needs none of this. The first staff member who works
  from two devices already exceeds what the model can represent.

## Attachment points in the current core

- **`RefreshTokenUseCase` at
  `apps/api-gateway/src/modules/auth/application/use-cases/refresh-token.use-case.ts` — where rotation
  and reuse detection actually live.** [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md) §3 specifies the
  design and it is real, but **it is not in the token adapter** — `JwtTokenAdapter` is a stateless
  signer that signs, verifies and reports an expiry, and holds no session state at all. The use case
  verifies the refresh JWT, resolves the subject across the staff and customer id spaces, argon2-verifies
  the presented token against the stored hash, and on a **mismatch** clears the live hash on the
  assumption of compromise before rejecting. That defensive clear is the existing revocation channel,
  and its blast radius is the whole account, because there is only one hash to clear.
- **The single `refreshTokenHash`, and what it costs.** `StaffUser` exposes it as one nullable field
  with one mutator, `rotateRefreshTokenHash`. Three consequences, all of them load-bearing here: a
  second login invalidates the first device without telling anybody; reuse detection signs the
  legitimate user out of everything they have, which is the intended circuit-breaker but is
  indistinguishable from an outage; and there is no way to end one session while keeping another.
- **`ValidateJwtSubjectUseCase` at
  `apps/api-gateway/src/modules/auth/application/use-cases/validate-jwt-subject.use-case.ts` — the
  per-request hook that already exists.** Every authenticated request already pays for one point check
  here: does an active staff row exist for this subject, or failing that an authenticatable customer
  row? It deliberately avoids loading the role/permission graph, because identity claims travel in the
  token. **This is where a session-level revocation check would go**, and the honest framing is that it
  upgrades an existence check into a session lookup on the hot path — the cost is real, and it is the
  price of being able to revoke an access token before it expires.
- **`jti` is minted and then dropped.** Both `LoginUseCase` and `RefreshTokenUseCase` generate a fresh
  UUID for the access token and another for the refresh token, and put them in the payloads. **Neither
  is persisted anywhere.** So a per-token revocation list is not merely absent — the identifier it would
  key on is already being generated and thrown away, which makes adopting one cheaper than it looks.
- **The two token lifetimes are the current answer to every session question.** An access token is
  short-lived and a refresh token long-lived (both configured, with 15-minute and 7-day defaults). Until
  a session record exists, that pair *is* the session policy, and it is the same for a warehouse tablet
  and an account holding `iam:role-edit`.
- **`StaffUser.suspend()` exists and no production path calls it** — the unit suite exercises the
  method, nothing under `apps/` invokes it — which is the staff-deactivation gap the root
  [`README.md` § Not built yet](../../../README.md#14-not-built-yet) records. It matters here because
  suspension and session revocation are the same operational act seen from two sides, and a deactivation
  route that does not also end live sessions closes only half the door.
- **The audit stream already has a place for an IP address, and it is structurally always null.** The
  staff-action wire shape carries an `ipAddress` field that the shared mapper hardcodes to `null`,
  because **no call site anywhere captures a request IP** — the gateway has correlation-id middleware,
  not client-address capture. Querying the audit log by IP returns nothing today and will keep doing so
  until something threads one through, which is a decision this capability forces rather than inherits.

## Implementation sketch

- **Replace the single hash with a `StaffSession` record per live session**: the subject, the hashed
  refresh token, issue and last-seen timestamps, an expiry, a revocation flag and reason, plus whatever
  device context is captured. Rotation updates the row rather than the aggregate's one field; reuse
  detection revokes **that** session, and — as a policy decision, not a side effect — optionally the
  subject's others.
- **Bind the session to the refresh token's `jti`.** The identifier is already minted; persisting it
  gives the refresh path a session to find without a scan, and gives revocation an exact target.
- **Decide the revocation latency explicitly.** Revoking a session stops *refresh* immediately and stops
  *access* only when the current access token expires. Closing that window means checking the session in
  the per-request validator — a lookup on every authenticated request, which is affordable behind a
  cache and is a real change to the system's cost profile. Choosing the window honestly is better than
  claiming an immediacy the design does not have.
- **Keep the device context minimal and derived.** A device label and a coarse client description are
  enough to make a session list useful. A full fingerprint is a tracking identifier, and the value it
  adds over a label is small next to what it obliges.
- **Treat the IP address and device context as personal data, and confine them.** They live on the
  session row — operational state, visible to the person they describe, deleted when the session ends
  or ages out — and **not** in event payloads and **not** in audit rows, which is exactly what
  [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) §4 forbids: those logs are the durable,
  replicated surface an erase cannot reach. Where a security record genuinely needs an origin, a
  truncated or hashed form answers "same network?" without storing a locator. Filling the audit's
  always-null `ipAddress` field is therefore a decision with a cost attached, not an obvious
  improvement — and it should be made once, deliberately, rather than by whichever call site first
  finds it convenient.
- **A retention horizon for session rows**, swept on the bounded-batch pattern the system already uses
  for expired reservations and aged delivery rows: a capped nightly tick that leaves the remainder for
  the next one.
- **IP allowlisting runs before authentication, and that is a wiring constraint rather than a
  preference.** The rule has to cover the login route, and the login route is `@Public()`, which
  short-circuits `JwtAuthGuard`. A check placed after it in the chain therefore never sees the request
  it most needs to see. Middleware — where correlation already runs — or a guard ordered ahead of
  authentication and deliberately not honouring the public opt-out are the two workable placements.
  Scope the rule to staff routes: applying it to the storefront locks out customers.
- **Trust the proxy explicitly or not at all.** Behind a load balancer the client address is a
  forwarded header, and a forwarded header is caller-supplied unless the proxy chain is configured to
  be trusted. An allowlist that reads an unvalidated header is a bypass with a configuration screen.
- **Audit session events with event names**: `SessionRevoked`, `AllSessionsRevoked`,
  `LoginFromNewDevice`, `IpRejected` — the audit `action` is a classifier of what happened, never a
  permission code.
- **Revoking someone else's session is its own permission code**, seeded in the same change; revoking
  one's own needs none, because ownership is the authorisation — the same reasoning the consent routes
  already apply on the customer side.
- **Events** ride `ris.events` (`auth.session.revoked`), ids only — never an address.
- **Shared types** (the session view, the revocation command) under `libs/contracts/<cluster>/`.

## Open design questions

- **Whether the per-request session check is worth its cost.** Immediate revocation on a busy gateway
  means a lookup per request; a short access-token lifetime achieves most of it for free. The answer
  depends on how bad a stale minute is, and that differs per route rather than per system.
- **What reuse detection should revoke.** Today it clears everything because everything is one row.
  With many sessions, revoking only the reused one is gentler and lets an attacker keep a session they
  stole earlier; revoking all of them keeps the circuit-breaker and signs out five innocent devices.
- **Whether customers get the same surface.** The refresh path is shared across staff and customers
  already, so the mechanism generalises for free — but a customer-facing device list is a product
  feature with its own privacy posture, not a security control.
- **Idle timeout versus absolute lifetime**, and whether either varies by the permissions a session
  carries. An account that can edit roles arguably deserves a shorter leash than one that reads the
  catalogue.
- **How allowlists survive real networks.** Home working, mobile connections and dynamic addressing all
  make a strict allowlist an operational burden, and the usual escape hatches — a VPN requirement, an
  exception list — move the problem rather than solve it.
- **Whether a "new device" is a thing worth notifying about.** It is a genuinely useful detection signal
  and, without a device concept sharper than a coarse label, a reliable source of false alarms.

## Effort sketch

`2–3 capabilities` — the session record replacing the single hash (with rotation, reuse detection and
retention moved onto it), the management surface to list and revoke, and IP allowlisting as a separable
third. It stays bounded **because** rotation, reuse detection and hashed-token storage already exist and
are being re-pointed rather than invented, the refresh path is a single use case, the `jti` the session
would key on is already minted, and there is already exactly one per-request hook where a revocation
check belongs. The genuinely new work is small and the genuinely hard question is not technical: it is
how much per-request cost immediate revocation is worth, and how little personal data a security
feature can be built on.
