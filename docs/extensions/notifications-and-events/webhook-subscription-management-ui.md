---
title: Webhook subscription management
cluster: Notifications & Events
effort: 2–3 capabilities
attaches_to:
  - libs/messaging/exchanges.constants.ts
  - apps/event-store-microservice/src/modules/audit-and-events/presentation/firehose.consumer.ts
---

# Webhook subscription management

## Description

**Webhook subscriptions** let a third party — a customer's ERP, an analytics tool, a partner's
fulfilment system — say *"POST me a JSON document whenever an order is placed"*, and then manage that
subscription: pick events, rotate the signing secret, see recent deliveries, replay a failed one.
Shopify, Stripe and commercetools all ship this, and the management surface is most of the product:
the HTTP call is a line of code, and everything else is retries, signatures, and the dashboard that
tells an integrator why their endpoint stopped receiving.

**The whole point of this guide is a direction.** The system already has a rich internal event bus —
`ris.events`, which every producer mirrors onto and a single `#`-bound queue drains. It is tempting
to describe outbound webhooks as "just another consumer of that". They are not, and the difference is
not cosmetic:

| | The internal bus | An outbound webhook |
| --- | --- | --- |
| **Destination** | a queue inside this system | a URL somebody else controls |
| **Trust** | fully trusted, same deployment | untrusted, unauthenticated by default |
| **Availability** | the broker is a dependency we operate | the endpoint may be down for a week |
| **Failure** | at-least-once redelivery, absorbed by idempotent ingest | our problem to retry, back off, and eventually give up |
| **Contents** | internal event payloads | a public, versioned contract we must not break |
| **Security** | none needed on the wire | signatures, secret rotation, SSRF defence |

A routing key is a destination we own. A webhook URL is a promise to a stranger.

## Business needs

- **Integrations are how a shop stops being an island** — ERP, accounting, 3PL, analytics and CRM all
  need to know when an order is placed, and polling an API is the version of that which does not scale.
- **Partners build on push, not pull** — an integrator who has to poll builds a worse product and
  generates far more load.
- **Self-service reduces support load** — an integrator who can see their own delivery failures and
  replay them does not open a ticket.
- **Marketplace and B2B contracts often require it** — a wholesale buyer's system expects to be
  notified, and "we'll email you a CSV" loses the account.
- The threshold: a shop with no external systems needs none of this; the first integration partner who
  asks "can you call us when X happens?" is the trigger, and the second one is what makes a management
  surface mandatory rather than a hardcoded URL.

## Attachment points in the current core

- **`EXCHANGES.RIS_EVENTS_TOPIC` (`ris.events`) at `libs/messaging/exchanges.constants.ts` — the one
  live exchange.** It is a durable `topic` exchange that every producer **mirrors** onto via the
  shared best-effort publisher (ADR-035), so the full event firehose is already available from a
  single binding without re-binding any existing consumer. `RETAIL` / `INVENTORY` / `NOTIFICATION`
  remain reserved placeholders that no producer addresses. **This is the source a webhook dispatcher
  subscribes to — and it must not become a second exchange or a second broker.** Everything outbound
  is one more consumer of the existing one.
- **`FirehoseConsumer` at
  `apps/event-store-microservice/src/modules/audit-and-events/presentation/firehose.consumer.ts` — the
  pattern to copy, precisely.** It binds a **lone `#`**, not `#.#`: with `wildcards: true` the pattern
  is both the AMQP binding key *and* Nest's own dispatch matcher, and that matcher only treats `#` as
  "match every remaining word" when it is the **last** segment — so `#.#` matches no multi-word
  routing key and Nest nacks it as an unsupported event. It then dispatches on the concrete routing
  key read from the context. **It never rethrows**, because an exception from an `@EventPattern`
  makes the broker blind-redeliver in a hot loop. A webhook dispatcher needs exactly this consumer
  shape, and gets to inherit both the `#` subtlety and the never-rethrow discipline rather than
  rediscovering them.
- **A second queue in the same app is not free.** One Nest app binds every handler pattern to every
  connected transport, so two queues with disjoint `@EventPattern` sets in one app is not supported —
  which is exactly why the event store's own second queue carries **RPC** patterns rather than events.
  A webhook dispatcher that needs its own event queue therefore wants its own module boundary
  considered against that constraint, not a casual second binding.
- **The `webhook` channel already exists** in `NotificationChannelEnum` — a DB `ENUM` value on
  `notification_template` and `notification_delivery`, and one that `NotificationTemplate` treats as
  **subject-bearing**. So a templated webhook body is already expressible today; what is missing is a
  transport, which the root [`README.md` § Not built yet](../../../README.md#14-not-built-yet) records
  alongside the email one.
- **`NotificationDelivery` as the delivery-log precedent.** Persist-before-dispatch, a monotonic
  `attemptCount` capped by `MAX_DELIVERY_ATTEMPTS`, a recorded `failureReason`, a retry sweeper, and a
  nightly bounded hard-delete at the `RETENTION_DELIVERY_DAYS` horizon. A webhook delivery log wants
  the same five properties — and a genuinely different retry curve, since a partner's endpoint can be
  down for far longer than an SMTP server.
- **`domain_event` in the isolated event store** — every mirrored event is already persisted verbatim
  with `occurred_at` and `received_at`, in a separate database. That is what makes **replay** possible
  at all: a webhook missed during an outage is re-derivable from a log that already exists.
- **Staff-facing management routes** belong at the gateway behind `@RequiresPermission(<code>)`, the
  notification module's staff-only routes being the precedent.

## Implementation sketch

- **Aggregates: `WebhookSubscription`** (target URL, subscribed event patterns, signing secret, active
  flag, owner) and **`WebhookDelivery`** (subscription, event, attempt count, status, response code,
  next attempt time) — the delivery-log shape, adapted.
- **One consumer, matched against subscriptions.** A `#`-bound consumer receives every mirrored event
  and matches its routing key against active subscriptions' patterns, then enqueues a delivery per
  match. **It never rethrows**: a matching or enqueue failure is logged, because the alternative is a
  hot redelivery loop that outlives the incident.
- **Dispatch is decoupled from consumption.** The consumer records intent; a worker performs the HTTP
  call. Coupling them means one slow partner endpoint stalls the queue for everyone — this is the
  single most important structural decision in the guide.
- **Retries are exponential with a long tail, and end in disabling.** An endpoint down for a day is
  ordinary. After a bounded run of failures the subscription is **automatically deactivated** and its
  owner notified — otherwise a dead endpoint is retried forever. `MAX_DELIVERY_ATTEMPTS` (default 3)
  is calibrated for a mail transport and is far too tight here; this is a separate, longer-horizon
  knob, and it arrives through its own DI value-provider token rather than being read from the
  environment in a use case.
- **Every request is signed.** An HMAC over the raw body with the subscription's secret, in a header,
  plus a timestamp to bound replay. Secret rotation supports two live secrets during a grace window,
  or integrators break on every rotation.
- **The payload is a public contract, and is not the internal event.** Internal payloads change with
  refactors; a webhook body must be versioned and mapped deliberately. The catalogue of published
  event types becomes a documented surface, and a **reserved** internal routing key with no business
  consumer is not automatically a public one.
- **No PII by default** (ADR-037). Internal events already carry ids rather than personal data, and a
  webhook body that "helpfully" enriches with an email address is an exfiltration path to a
  third-party URL. Enrichment, if offered at all, is explicit and per-subscription.
- **SSRF defence at registration and at dispatch.** A subscriber-supplied URL is an outbound request
  from inside the network: block private and link-local ranges, require HTTPS, re-validate after
  redirects, and re-check on each dispatch — DNS can be re-pointed after registration passes.
- **Replay from the event store**, bounded and staff- or owner-initiated, using `domain_event` as the
  source of truth.
- **Shared types** (the subscription and delivery views, the versioned payload envelopes) under
  `libs/contracts/<cluster>/`.

## Open design questions

- **Which service owns the dispatcher.** The event store already drains the firehose but is
  deliberately an isolated, append-only capture with its own database; adding outbound HTTP to it
  muddies that. A new module — or a new deployable — keeps the capture clean, at the cost of a second
  `#` consumer on the same exchange.
- **Ordering guarantees.** Partners often assume events arrive in order; with parallel dispatch and
  retries they will not. Per-subscription serialisation costs throughput, and admitting "unordered,
  use the timestamps" costs integrator goodwill.
- **Payload versioning strategy** — a version in the URL, in a header, or per subscription. Whatever
  is chosen must survive an internal event's payload changing, which is the case that actually happens.
- **Which events are publishable.** Every mirrored key is available, but not all are safe or stable to
  expose; a `reserved surface` with no internal consumer is the trap, since it looks unused and free.
- **Multi-tenant scoping** — a marketplace seller must only receive their own orders' events, which
  means per-subscription authorisation filtering on top of pattern matching, and the `t:<tenantId>`
  cache-key segment is the only tenancy hook that exists today.
- **Whether the inbound direction is in scope.** Receiving an ESP's delivery-status callback is the
  mirror-image capability and is already a recorded gap — the
  `notification.delivery.record-outcome` RPC exists with no HTTP route in front of it, listed in the
  same [`README.md`](../../../README.md#14-not-built-yet) section. It shares the signature-verification
  machinery and nothing else.

## Effort sketch

`2–3 capabilities` — subscription management with secret rotation, a matching consumer plus a
decoupled dispatch worker with its own retry horizon, signing and SSRF defence, and a delivery log
with replay. It is bounded **because** the firehose already exists and is already mirrored, the
`#`-bound consumer shape is established down to the pattern subtlety, every event is already
persisted verbatim for replay, and the delivery-log pattern is proven. The cost that is easy to
underestimate is not the HTTP call — it is that the payload becomes a public contract, and public
contracts are the ones you cannot refactor.
