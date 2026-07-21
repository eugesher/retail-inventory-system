---
title: Push device-token registration
cluster: Notifications & Events
effort: 2–3 capabilities
attaches_to:
  - apps/api-gateway/src/modules/auth/domain/customer.model.ts
  - apps/notification-microservice/src/modules/notifications/application/ports/notifier.port.ts
---

# Push device-token registration

## Description

A **push notification** reaches a customer's phone or browser without an email or an SMS: "your order
is out for delivery", "the item you wanted is back in stock". Sending one requires a **device token**
— an opaque string APNs, FCM or the Web Push API issues to a specific app install on a specific
device — which the shop must collect, store, keep fresh, and retire when it stops working.

This guide is about the **token registry**, not the transport. The `push` channel already exists as a
`NotificationChannelEnum` member and as a value in two DB `ENUM` columns; what is missing is a real
transport behind `NOTIFIER` (a gap the root [`README.md` § Not built yet](../../README.md#14-not-built-yet)
already records) and the token to address. A token is **customer-owned personal data on a
device the customer controls**, which makes registration, rotation and erasure the substance of this
capability, and the send itself comparatively trivial.

This and [in-app-inbox-feed.md](in-app-inbox-feed.md) are both new channels behind the same `NOTIFIER`
port — push carries a message *out* to a registered device, an inbox holds it *until* the customer
fetches it. Neither re-derives the other's transport.

## Business needs

- **Immediacy for time-critical notices** — a delivery window or a fraud hold is worth a buzz in the
  pocket; an email read three hours later is not the same message.
- **Deliverability without an address** — a customer who never opens email, or whose address has hard
  bounced, is still reachable on a device they installed voluntarily.
- **Re-engagement for app-first shops** — for a shop whose sales are mostly in-app, push is the
  primary marketing channel rather than a supplement.
- **Lower marginal cost than SMS** — per-message carrier fees disappear.
- The threshold: a shop with no app and no service worker has nowhere for a token to come from;
  the first mobile app or installable storefront is what makes this capability possible at all.

## Attachment points in the current core

- **`Customer` at `apps/api-gateway/src/modules/auth/domain/customer.model.ts` — the owner, and the
  erasure obligation.** `Customer` is gateway-owned domain state, the only aggregate outside a
  microservice. Its PII fields are **mutable solely so `erase()` can null them**: the tombstone-erase
  (ADR-037 §2) nulls every PII field, flips `status` to `deleted`, stamps `deletedAt`, and the model's
  status-conditional invariant lets a `deleted` row rehydrate with a null email that a live customer
  could never have. A device token is customer data of exactly this kind, so **erasure must reach it**
  — see the sketch below, where the honest answer is *delete the row*, not null a column.
- **`NOTIFIER` at
  `apps/notification-microservice/src/modules/notifications/application/ports/notifier.port.ts`.** One
  synchronous seam, `send(notification)`, bound to `LogNotifierAdapter` by default (or the
  deterministically-flaky variant under `NOTIFIER_TEST_FLAKY`). A push transport is a new adapter
  behind this port; **the port does not change**, and it stays the only place a transport SDK may be
  imported.
- **`NotificationChannelEnum.PUSH` already exists** — a wire contract and a DB `ENUM` value on both
  `notification_template` and `notification_delivery`. So a push template is already expressible, and
  `NotificationTemplate`'s channel-specific subject rule already treats `push` as **subject-less**
  (only `email` and `webhook` require one), which matches how a push payload is actually shaped.
- **The delivery row and its retry ladder.** A push send writes the same `NotificationDelivery` row as
  an email: `QUEUED` before dispatch, then `SENT`/`FAILED` with a monotonic `attemptCount` capped by
  `MAX_DELIVERY_ATTEMPTS`, re-attempted by the existing sweeper. **A push provider's rejection is not
  a generic failure**, though — an "unregistered token" is permanent and must retire the token rather
  than consume three attempts against a device that no longer exists.
- **The consent gate.** Classification is by `eventType`, not channel: a push whose `eventType` is
  outside `TRANSACTIONAL_EVENT_TYPES` is marketing. Note the gate's current shape reads
  `consent.marketingEmail` for email and `consent.marketingSms` for sms — **there is no
  `marketingPush` flag on the consent snapshot today**, so a push channel needs the consent model
  extended rather than borrowed. Borrowing the email flag would mean a customer who opted into email
  marketing silently opted into push.
- **The gateway's `auth` module and its owner-check precedent.** Registering a token is a
  customer-facing write; the `cart` module's owner-check (no permission code) is the pattern, not a
  `PermissionCodeEnum` gate.

## Implementation sketch

- **A `DeviceToken` entity owned by the customer**, carrying the opaque token, the platform
  (`ios`/`android`/`web`), an app/browser identifier, `lastSeenAt`, and an active flag. One customer
  has many; one token belongs to at most one customer, and re-registering a token that moved to a
  different account must reassign it, not duplicate it — a shared tablet is the case that breaks a
  naive unique-per-customer key.
- **Registration and de-registration are gateway routes on the customer's own resource**, owner-checked
  against `@CurrentUser()`. The client re-registers on every launch, so the write is an upsert that
  refreshes `lastSeenAt` — this is the mechanism that keeps the registry from rotting.
- **Erasure deletes the row; it does not null a column.** Tombstone erasure nulls PII *in place*
  because the row must survive for referential integrity — an order points at its customer. A device
  token has no such dependant, and a nulled-out token row is useless. **Deleting the tokens is both
  simpler and more complete**, and it must be part of the same erase path that nulls the customer's
  PII, not a separate cleanup. The `customer.erased` event already exists and is already consumed by
  the notification service to evict the consent cache; a token registry would consume it too, which
  keeps the deletion asynchronous and idempotent — and **that consumer never rethrows**, because a
  thrown handler blind-redelivers in a hot loop.
- **A `PushNotifierAdapter` behind `NOTIFIER`**, holding the provider SDK. It resolves the recipient's
  active tokens, sends per token, and classifies the response: transient failures feed the existing
  retry ladder; a **permanent** rejection (unregistered, invalid) deactivates the token immediately so
  the next send does not repeat it.
- **Extend the consent snapshot with a marketing-push flag** rather than reusing the email one. It
  defaults **false** like the other marketing flags, flows through `CONSENT_READER` and the
  write-through `CONSENT_CACHE`, and is written by the same `customer.consent.updated` path — the
  cache's fail-safe fallback to `DEFAULT_CONSENT` then suppresses marketing push during an outage
  rather than leaking it.
- **OS-level permission is a second gate the backend cannot see.** A customer can revoke notifications
  in system settings without telling the shop; the only signal is the provider's rejection, which is
  why permanent-failure handling *is* the consent-revocation path in practice.
- **Events ride `ris.events`** with dotted routing keys — no new exchange, no second broker. **No PII
  in a payload** (ADR-037): a token is a device identifier and must never appear in an event payload
  or an audit row; events carry the customer id and a token id.
- **Shared types** (the registration payload, the device view) under `libs/contracts/<cluster>/`; a
  cached token lookup names a `CACHE_KEYS` builder, never a literal.

## Open design questions

- **Where the registry lives.** Tokens are customer data, which argues for the gateway `auth` area
  next to `Customer` and the erase path; sending needs them in the notification service, which would
  otherwise read them across a context boundary (the `CONSENT_READER` parameterized-SQL precedent is
  the established way to do that).
- **Token lifetime and pruning.** Providers rotate tokens and users uninstall apps silently. A token
  unseen for months is probably dead; whether pruning is a `lastSeenAt` sweep (the retention-purge
  precedent) or purely reactive to provider rejections trades cost against a growing dead registry.
- **Fan-out semantics for multiple devices.** One notification to a customer with four devices is
  four sends — but the delivery dedupe key is scoped per `(template, reference, channel, customer)`,
  so four rows collide on it. Either the dedupe scope widens to include the device, or one delivery
  row represents a multi-device send with partial failure — and the second needs a status the walk
  does not have.
- **Rich payloads and deep links** — images, actions and a target screen make a push materially more
  useful and push the template body past a rendered string toward a structured payload.
- **Web push versus mobile push** — VAPID and service workers are a different registration and
  expiry model from APNs/FCM, and pretending they are one platform leaks into the adapter.

## Effort sketch

`2–3 capabilities` — a device-token entity with owner-checked registration and reassignment, erasure
integration, a push adapter behind the existing port with permanent-versus-transient failure
classification, and a marketing-push consent flag threaded through the reader and cache. It is
bounded **because** the `push` channel, the template registry, the delivery row, the retry ladder and
the `customer.erased` event all already exist. The parts that are genuinely new are the ones nobody
budgets for: token reassignment across accounts, permanent-failure retirement, and making sure an
erased customer's devices actually go quiet.
