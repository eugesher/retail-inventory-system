# The notification consent-gate: cache-aside consent and the dispatch gate

Once a customer can record channel-consent (`transactionalEmail` /
`marketingEmail` / `marketingSms`) and can be erased, the notification service
has to **honor that consent on every outgoing message**. A customer who has
opted out of marketing email must not receive a marketing email; an erased
customer must stop receiving marketing altogether; but a transactional message
(an order confirmation, a shipment notice) must keep flowing regardless of the
marketing opt-in. This document describes how the notification service enforces
consent on the dispatch hot path — the raw-SQL consent reader, the cache-aside
layer that fronts it, the events that keep it fresh, the gate itself, and the
operator marketing-send path that makes the whole thing demonstrable.

The governing decision is
[ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md); the pipeline it
plugs into is
[ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md)'s
persist-then-send Render & Dispatch flow.

## The problem: consent on a hot path

Every customer-facing notification flows through one use case,
`RenderAndDispatchUseCase`: it resolves the active template, renders the
subject/body, persists a `queued` delivery row, calls the transport, and flips
the row to `sent`/`failed`. Consent has to be checked **before** the transport
call — and this runs on every order-placed, shipment, refund, and return event.

The consent record itself lives in the **api-gateway `auth` module**'s
`consent_record` table. The obvious implementation — an RPC back to the gateway
per delivery to ask "may I email this customer?" — would put a synchronous
cross-service round trip on the busiest path in the system. That is exactly the
dependency [ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md)
already removed for customer contact details (it enriches the producer event
with `customerEmail` instead of looking it up per delivery). We take the same
posture for consent: **read it locally, cache it, and keep the cache fresh from
events** — never an RPC per delivery.

## Cache-aside consent

The consent snapshot the gate needs is tiny — three booleans plus a retention
label. Two collaborators resolve it:

**The raw-SQL reader (`CONSENT_READER`).** The notification service shares the
one `retail_db`, so the `consent_record` table is physically reachable — but the
`ConsentRecordEntity` that owns it lives in the gateway `auth` module, behind a
hard cross-context isolation line the boundaries lint enforces
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)). So the reader reaches
the table with **parameterized SQL through an injected `EntityManager`**, never
importing the gateway entity — the exact precedent the retail orders module uses
to read the cart tables (`ORDER_CART_READER`, ADR-026 §5). It selects the three
consent flags plus the retention policy for one `customer_id`, and returns a
small snapshot or `null` for an absent row.

**The cache-aside layer (`CONSENT_CACHE`).** A domain-shaped cache over the
generic `ICachePort` (the inventory `IStockCachePort` precedent,
[ADR-006](../../adr/006-cache-aside-via-libs-cache.md) /
[ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md)): the
gate depends on this port and never sees a cache-key string or the SQL reader.
On a `get(customerId)`:

- a **hit** returns the cached snapshot;
- a **miss** `singleFlight`s the reader load (so a stampede of concurrent
  dispatches to the same customer collapses to one DB read,
  [ADR-021](../../adr/021-cache-single-flight-and-ttl-jitter.md)), writes the result
  back under a TTL, and returns it;
- an **absent row** resolves to the defaults — `transactionalEmail = true`,
  `marketingEmail = false`, `marketingSms = false` — so a customer who has never
  touched their consent settings can still receive order confirmations but no
  marketing (the opt-in, GDPR posture of ADR-037).

The key shape is `ris:notifications:consent:v1:<customerId>` — the first
**consumed** notification cache key (the template cache key from ADR-033 remains
reserved). This is also the first time the notification service wires
`CacheModule` at all; it reuses the `REDIS_URL` the service's environment already
provides.

**Cache errors warn-and-swallow** ([ADR-002](../../adr/002-redis-cache-aside-product-stock.md)).
The cache is a hot-path optimization, not a correctness gate: if Redis is down,
`get` falls back to the reader directly; if the reader also fails, it falls back
to the defaults. Crucially, `get` **never throws** — its caller is an
`@EventPattern` consumer, where a thrown error blind-redelivers the event under
at-least-once RMQ ([ADR-011](../../adr/011-notifier-port-and-adapters.md) §7).
The fail-safe direction is deliberate: on any failure the defaults let
transactional mail through while keeping marketing suppressed — a consent-store
hiccup never blocks an order confirmation and never leaks a marketing email.

The TTL (`NOTIFICATIONS_CONSENT_CACHE_TTL_SECONDS`, default 300s) is only a
**staleness safety net**. The primary freshness mechanism is events.

## Event-driven freshness

The gateway already emits two `customer.*` privacy events onto
`notification_events` (and mirrors them onto `ris.events`): `customer.consent.updated`
carries the **full** consent snapshot, and `customer.erased` carries only the
customer id (no PII — the whole point of the erase is to destroy PII). A single
consumer, `ConsentEventsConsumer`, keeps the cache aligned with them:

- **`customer.consent.updated` → write-through.** The event already carries every
  flag, so the consumer writes the snapshot straight into the cache — **no DB
  read**. A consent change a customer just made is reflected on their very next
  dispatch, without waiting for the TTL to lapse.
- **`customer.erased` → eviction.** The consumer deletes the cached entry. A
  subsequent dispatch re-loads the absent-row defaults (marketing denied), so an
  erased customer's marketing sends stop — the consent-gate short-circuits them.

Both handlers log `correlationId` inline (never `PinoLogger.assign`, which throws
outside request scope) and **never rethrow** — an at-least-once redelivery is
harmless (a write-through is idempotent, an eviction of an already-absent key is a
no-op), and a thrown error would only cause a pointless redelivery loop.

## The gate

The gate sits inside `RenderAndDispatchUseCase`, **after** the template resolves
and renders and **before** the `queued` row is persisted, so an unconsented send
writes a `skipped-no-consent` row instead of a `queued` one and never reaches the
transport.

1. **Only customer-facing rows are gated.** A system/ops dispatch — the low-stock
   alert to the ops mailbox — has a `null` recipient customer id; the gate skips
   it entirely (no consent applies to an internal alert), exactly as the dedupe
   pre-check already skips it.
2. **Resolve consent** via `CONSENT_CACHE.get(customerId)`.
3. **Classify the send** and pick the flag it is gated on:
   - **Transactional email** — channel is email *and* the `eventType` is in
     `TRANSACTIONAL_EVENT_TYPES` (the set of seeded transactional event types:
     `retail.order.placed`, `retail.order.cancelled`, `retail.fulfillment.shipped`
     / `.delivered`, `retail.refund.issued`, and the four buyer-facing
     `retail.return.*`). Gated on `transactionalEmail` — this is the **bypass**: a
     customer gets order confirmations even with marketing off.
   - **Marketing email** — channel is email and the `eventType` is *not* in the
     set. Gated on `marketingEmail`.
   - **Marketing SMS** — channel is sms. Gated on `marketingSms`.
   - **push / webhook** — out of scope for this capability; treated as ungated
     (send) to preserve today's behavior rather than silently dropped.
4. **If the applicable flag is `false`**, the gate short-circuits: it persists a
   delivery directly in the new terminal status `skipped-no-consent` (recording
   the rendered subject/body that *would* have been sent, for the audit trail),
   logs at info, and **returns without calling the transport**. The skipped row
   carries the same dedupe key as a real send, so an at-least-once redelivery
   collapses onto it at the dedupe pre-check instead of writing a second row.
5. **If consented**, the existing persist-then-send path runs unchanged.

`skipped-no-consent` is a new value on `NotificationDeliveryStatusEnum` and on the
`notification_delivery.status` ENUM column (a `MODIFY`-column migration adds it).
It is **terminal by construction** — the `NotificationDelivery.skipped()` factory
builds the row directly in that status with `attemptCount = 0`, and none of the
attempt/receipt mutators can transition into or out of it (they require `queued` /
`failed` / `sent`). So the retry sweeper never re-attempts a skipped row, and the
delivery audit trail cleanly distinguishes "we chose not to send this" from "we
tried and failed".

## The marketing-send seam

The transactional events above all originate from real retail activity, but a
*marketing* dispatch needs a deliberate trigger — and without one the marketing
half of the gate is untestable. So the notification service exposes a thin,
staff-gated marketing path:

- **RPC** `notification.marketing.send` → `SendMarketingUseCase`, which maps the
  operator's `{ customerId, customerEmail, eventType, campaignId, context }` onto
  the Render & Dispatch input: channel email, recipient the named customer,
  reference type `marketing`, reference id the `campaignId`, and a marketing
  `eventType` (default `marketing.email.promo`, deliberately **not** in
  `TRANSACTIONAL_EVENT_TYPES`). The consent-gate then decides send vs
  `skipped-no-consent` — the seam itself never inspects consent.
- **Gateway** `POST /api/notifications/marketing/send`
  (`@RequiresPermission(notifications:write)`) fronts it. It resolves the marketing
  `eventType` default and **mints a fresh `campaignId` per request** before
  dispatching. The per-request campaign id is what lets an operator send to the
  same customer more than once: each send is a distinct delivery row, while an
  at-least-once redelivery of one request (carrying the same id) still dedupes.
  `customerEmail` is a documented **operator input** on the request body rather
  than a server-side lookup of the gateway `auth` module's `customer` table —
  reading that table from the notifications gateway module would cross a module
  boundary for no functional gain, so the simpler, boundary-clean shape carries
  the email on the request.

The seeded marketing template that `marketing.email.promo` renders against is a
follow-up concern; until it exists, a marketing send resolves no template and
returns an empty `200`.

## How it honors the ADRs

- **ADR-037** — the notification-side `CONSENT_READER` over the shared
  `consent_record`, cache-aside with `singleFlight`, refreshed by
  `customer.consent.updated` / cleared by `customer.erased`; the transactional
  bypass; the new terminal `skipped-no-consent` status.
- **ADR-033** — the gate plugs into the persist-then-send `RenderAndDispatchUseCase`
  without changing its shape; `skipped-no-consent` extends the delivery status
  machine; the consumer lives under `infrastructure/consumers/` like the rest.
- **ADR-006 / ADR-016 / ADR-021 / ADR-022 / ADR-023** — the consent cache uses the
  `ICachePort` abstraction, a versioned `CACHE_KEYS` builder, `singleFlight`
  miss-dedupe, and warns-and-swallows on error.
- **ADR-002** — cache-aside with the TTL as a safety net and errors that never
  break the dispatch.
- **ADR-011** — the consumer translates wire payloads to a use-case call, logs
  `correlationId` inline, and never rethrows from an `@EventPattern`.

## Related documents

- [01 — The ConsentRecord aggregate and the tombstone-ready identity schema](./01-consent-record-aggregate.md)
- [04 — The `customer.erased` event and the no-PII rule](./04-customer-erased-event-and-pii.md)
- [ADR-037 — ConsentRecord and tombstone-based customer erasure](../../adr/037-consent-record-and-tombstone-erasure.md)
- [ADR-033 — Notification templates, deliveries, and the render-and-dispatch pipeline](../../adr/033-notification-templates-deliveries-and-render-dispatch.md)
- [ADR-002 — Redis cache-aside for product stock](../../adr/002-redis-cache-aside-product-stock.md)
- [ADR-016 — Cache-aside generalized](../../adr/016-cache-aside-generalized.md)
