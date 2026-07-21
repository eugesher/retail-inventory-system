---
title: In-app inbox and feed
cluster: Notifications & Events
effort: 2–3 capabilities
attaches_to:
  - apps/notification-microservice/src/modules/notifications/domain/notification-delivery.model.ts
  - apps/notification-microservice/src/modules/notifications/application/ports/notifier.port.ts
---

# In-app inbox and feed

## Description

An **in-app inbox** is the bell icon and the message list inside the storefront or account area:
"your order shipped", "your return was approved", "your wishlist item is back in stock" — the same
messages the shop emails, kept in a durable, readable list the customer can come back to. Braze,
Iterable and OneSignal all ship an in-app message centre next to their email and push channels,
because a customer who deleted the email still needs the shipment number.

The distinction that shapes the whole guide: every existing channel is a **push in the general
sense** — the system hands a rendered message to a transport that carries it away, and the delivery
row records what happened to it. An inbox is not carried anywhere. **Its delivery is a read**: the
message is stored, and "delivered" means the customer opened the app and fetched it, which may be
next week or never. Everything awkward about fitting an inbox into the current model follows from
that one inversion.

This and [push-device-token-registration.md](push-device-token-registration.md) are both new
channels behind the same `NOTIFIER` port, and both use a `NotificationChannelEnum` member that
already exists — push carries a message *out* to a device, an inbox holds it *until* fetched. That
one sentence is the whole relationship; neither guide re-derives the other's transport.

## Business needs

- **Messages outlive their transport** — an email is deleted, an SMS is buried; an order's status
  history should be readable where the order is.
- **A channel that cannot bounce or be filtered** — spam folders, blocked senders and stale addresses
  make email unreliable for exactly the notices a customer most needs.
- **Lower cost and no consent friction for service messages** — an inbox entry has no per-message
  transport cost and no deliverability reputation to protect.
- **Engagement surface** — a feed is where restock alerts, order updates and offers can sit together
  without competing for inbox attention.
- The threshold: a shop whose customers interact once per purchase gains little; a storefront with
  accounts, repeat visits and multi-step fulfilment is where an in-app list earns its place.

## Attachment points in the current core

- **`NotificationChannelEnum` already has four members** — `email`, `sms`, `push`, `webhook` — and it
  is a **wire contract**: a DB `ENUM` column on both `notification_template` and
  `notification_delivery`, crossing the gateway↔notification RPC boundary. An inbox is a **fifth
  member**, which means a migration on two tables and a contract change, not a free addition. Worth
  noting the alternative: reusing `push` would collapse two channels whose delivery semantics are
  opposites.
- **`NotificationDelivery` at
  `apps/notification-microservice/src/modules/notifications/domain/notification-delivery.model.ts`.**
  It is already *most* of an inbox row: it stores `renderedSubject` and `renderedBody` durably, links
  back to the business event via `eventReferenceType`/`eventReferenceId`, carries the recipient, and
  is queryable. **A delivery row is deliberately never soft-deleted** — `deletedAt` is inert, because
  the row is the source of truth for "did we already send this?" and a hidden-but-present row breaks
  the dedupe query. It *is* hard-deleted when it ages out, at the `RETENTION_DELIVERY_DAYS` horizon
  (default 90) by a nightly bounded purge. **That retention horizon is the sharpest constraint on
  reusing the table**: an audit log may be pruned at 90 days; a customer's message history disappearing
  at 90 days is a product decision nobody made.
- **The status walk is transport-shaped.** `QUEUED → SENT → DELIVERED | BOUNCED`, with
  `QUEUED|FAILED → FAILED` and `FAILED → SENT` on a successful retry; `attemptCount` is monotonic and
  capped by `MAX_DELIVERY_ATTEMPTS`, and the terminal `SKIPPED_NO_CONSENT` records a suppressed send.
  An inbox message has no attempts, cannot bounce, and needs `read`/`unread` and `dismissed` — states
  the walk has no room for. **`SENT` on write is the honest mapping** (the message is available), and
  read-state is a separate concern, not a status transition.
- **`NOTIFIER` at
  `apps/notification-microservice/src/modules/notifications/application/ports/notifier.port.ts`.** A
  single `send(notification)` method, bound to `LogNotifierAdapter` by default; the port is the seam
  a real transport fills, and the root [`README.md` § Not built yet](../../../README.md#14-not-built-yet)
  already records that the real transports are the gap. An inbox adapter is the *cheapest possible*
  implementation of this port — its `send` writes a row and returns — which is precisely why it makes
  a good first non-log binding.
- **`RenderAndDispatchUseCase`** — the single persist-then-send pipeline every consumer calls. An
  inbox message reuses it wholesale: template resolution, render, consent gate, the queued row, the
  dedupe key. Only the adapter behind `NOTIFIER` differs.
- **The gateway has no notification routes for customers.** The notification module's eight
  `@MessagePattern` RPCs are staff-facing (template authoring, delivery listing, retry, marketing
  send). An inbox needs **customer-facing** reads — a new RPC pair and a new owner-checked gateway
  route, the `cart` module's owner-check being the precedent rather than a permission code.

## Implementation sketch

- **Add `inbox` to `NotificationChannelEnum`, and treat it as a channel, not a special case.** The
  template registry keys on `(eventType, channel, locale)`, so an inbox template for `retail.order.placed`
  is an ordinary row. The channel-specific subject rule needs a decision: `email`/`webhook` require a
  subject, `sms`/`push` do not — an inbox entry with a title reads better, so it likely joins the
  subject-bearing set.
- **Bind an `InboxNotifierAdapter` behind `NOTIFIER`.** Its `send` persists (or simply confirms) the
  stored message and returns; there is no external call, so it never throws for transport reasons and
  the retry ladder is inert for this channel by construction rather than by exception.
- **Store read-state beside the message, not in its status.** An `InboxEntry` (or a read-state
  companion keyed to the delivery) carries `readAt` and `dismissedAt`. Keeping it separate leaves the
  delivery status walk meaning what it has always meant, and lets read-state be updated by the
  customer without touching the dispatch audit trail.
- **Decide retention deliberately, and separately.** Either exempt inbox rows from the nightly purge
  or give them their own horizon through their own DI token. Silently inheriting a 90-day delete is
  the single most likely defect in this capability, and it will present as "my order history
  vanished", months after release.
- **Customer-facing reads are owner-checked.** List, unread-count and mark-read RPCs on
  `notification_events`, fronted by gateway routes that check ownership against `@CurrentUser()` —
  the cart precedent. A customer must not be able to read another's inbox by id.
- **Consent: an inbox entry is not marketing by transport, but may be by content.** The gate
  classifies by `eventType`, not channel: an `eventType` outside `TRANSACTIONAL_EVENT_TYPES` is
  marketing regardless of where it lands. A promotional inbox card is therefore gated the same way a
  promotional email is — which is the right answer, and it comes for free from routing through the
  pipeline.
- **Events ride `ris.events`** — no new exchange, no second broker. **No PII in a payload** (ADR-037):
  an inbox event carries ids, and the rendered body stays in the row.
- **Shared types** (the inbox entry view, the unread count) under `libs/contracts/<cluster>/`; any
  cached unread count names a `CACHE_KEYS` builder, never a literal.

## Open design questions

- **Reuse `notification_delivery` or add an `inbox_entry` table.** Reuse inherits rendering, dedupe
  and the audit trail but forces the retention question and stretches a transport-shaped status walk;
  a separate table is cleaner semantically and duplicates the dispatch machinery. The retention
  horizon is the deciding argument, not the schema.
- **Fan-out on read vs. on write.** Writing an entry per recipient is simple and matches the existing
  per-recipient row; a shared message with per-customer read-state scales better for broadcasts. A
  campaign-driven feed pushes hard toward the latter.
- **Real-time delivery.** A bell that updates without a refresh needs a push transport or a socket —
  which is [live-customer-messaging.md](live-customer-messaging.md)'s territory, not this guide's.
  Polling is the honest starting point.
- **Expiry and relevance** — a "back in stock" card is stale in a day, an order receipt is not;
  whether entries carry their own lifetime is a content-type decision.
- **Whether staff get an inbox too.** The ops mailbox currently receives low-stock alerts as
  null-recipient rows that skip the consent gate entirely; a staff-facing feed would be a second
  audience with different reads.

## Effort sketch

`2–3 capabilities` — a channel member and its migration, an inbox adapter behind the existing port,
read-state, the customer-facing read RPCs and owner-checked routes, and a deliberate retention
decision. It is bounded **because** the message content, the per-recipient row, the template
registry, the consent gate and the dispatch pipeline are all already built and inherited — the new
code is a trivial adapter plus a read surface. The risk is not in the code; it is in silently
inheriting a delete horizon designed for an audit log.
