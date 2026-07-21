---
title: Live customer messaging
cluster: Notifications & Events
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/api-gateway/src/modules
  - apps/notification-microservice/src/modules/notifications
---

# Live customer messaging

## Description

**Live customer messaging** is the chat widget: a customer types a question, an agent answers within
seconds, and both sides see the conversation update without a refresh. Intercom, Zendesk Chat,
Gorgias and Shopify Inbox all build the same thing — a persistent **conversation** between a customer
and a rotating cast of agents, delivered over a live connection, with history, assignment, presence
and typing indicators.

It is the only guide in this cluster that proposes a **new deployable**, and it is worth being blunt
about why the existing service cannot host it. Everything the notification service does is
**fire-and-forget, one-way and stateless per message**: an event arrives, a template renders, a row
is written, a transport is handed the result. Live chat is **bidirectional, stateful and
connection-oriented** — it needs long-lived sockets, presence, and the ability to route a message to
whichever agent holds a conversation *right now*. Those are opposite operational shapes, and a
socket-bearing process is scaled, deployed and drained differently from an RMQ consumer.

## Business needs

- **Pre-purchase questions convert** — a shopper stuck on sizing or delivery either asks or leaves,
  and the answer arrives too late by email.
- **Support deflection and cost** — a chat agent handles several concurrent conversations where a
  phone line handles one.
- **Context-rich support** — an agent who can see the customer's order, shipment and return status
  while typing resolves in one exchange what a ticket thread takes three days to.
- **Proactive outreach** — triggering a chat invitation when a shopper stalls at checkout is a
  different capability from emailing them later, and a different one again from the abandoned-cart
  sequence.
- The threshold: a shop whose support volume fits in a mailbox does not need it; sustained
  concurrent pre-sales questions, or a high-touch category, is where live beats asynchronous.

## Attachment points in the current core

- **`apps/` holds six deployables**, and their shapes are the two precedents this capability sits
  between. `api-gateway` is the only HTTP deployable — prefix `/api`, three global guards
  (`JwtAuthGuard` → `RolesGuard` → `PermissionsGuard`), `CorrelationMiddleware`, and thin RPC-fronting
  modules over RabbitMQ. `notification-microservice` is RMQ-only with **no HTTP surface at all**. A
  live-messaging service is neither: it terminates long-lived client connections like the gateway,
  but owns real domain state like a microservice.
- **The gateway's module layout at `apps/api-gateway/src/modules` — the shape precedent.** Every
  module there is `application/ports` + `application/use-cases` + `infrastructure/messaging` +
  `presentation`, and the gateway `auth` module is the one that additionally owns real `domain/` and
  DB rows. **A messaging service is the `auth`-shaped case**: ports, use cases, messaging adapters,
  presentation *and* a domain with persistence. The per-module hexagonal layout and the composition
  root at `modules/<m>/<m>.module.ts` apply unchanged, and `yarn lint` — with its `boundaries/*`
  rules and `no-unknown-files` set to `error` — is the authority on where each file goes. A new
  deployable does not get to weaken a boundary rule.
- **The notification module at `apps/notification-microservice/src/modules/notifications`** — what
  live messaging must *not* duplicate. The template registry, the renderer port, the per-recipient
  delivery row, the consent gate and the retry ladder all exist there for **outbound, templated,
  one-way** messages. A chat message is authored by a human in real time: it is not templated, not
  consent-gated as marketing, and not retried on a ladder. **The overlap is smaller than it looks**,
  and the seam worth reusing is narrow: when a conversation goes unanswered and the customer has left,
  the follow-up *email* is an ordinary templated notification and should be dispatched through the
  existing pipeline rather than sent by the chat service.
- **Authentication.** The gateway's JWT guards and `@CurrentUser()` establish identity for HTTP; a
  socket connection needs the same identity resolved at handshake, and a guest chat needs an
  anonymous session that can later be claimed by a login. `@Public()` marks the opt-out today, and an
  anonymous-but-tracked participant is a third case neither guard covers.
- **`Customer` and consent.** A conversation is customer data: erasure (ADR-037) is tombstone-only,
  and a chat transcript is dense with PII, so what erasure does to a transcript must be decided
  before the first message is stored, not after.

## Implementation sketch

- **A new deployable, `chat-microservice`, hosting a WebSocket gateway and its own domain.**
  Aggregates: `Conversation` (participants, state, assignment) owning `Message` (author, body,
  timestamp, read receipts). The per-module hexagonal layout, the ADR-041 composition root, and the
  boundary rules are inherited — the socket handler is `presentation/`, the socket server binding is
  `infrastructure/`, and the domain stays framework-free.
- **The socket is a transport, not a bus.** Server-to-server communication stays on RabbitMQ; the
  socket carries only client traffic. Cross-service facts a conversation needs — this customer's
  recent orders — are fetched over the existing RPC seams, never by a direct HTTP call between
  services.
- **Fan-out across instances rides `ris.events`, and does not become a second broker.** Two agents
  connected to two instances must both see a message. The conversation is persisted first; the
  in-flight notification is a dotted routing key (`chat.message.posted`) mirrored onto the one live
  topic exchange by the shared publisher, and each instance relays to its own connected sockets.
  Anything that would need a *different* exchange or a *second* broker is a signal the design drifted.
- **Presence and typing are ephemeral and belong in the cache**, never in MySQL — TTL'd entries under
  a `CACHE_KEYS` builder, with `CacheModule` registered once at the app root. Losing them on a restart
  is correct behaviour, not data loss.
- **Message history is durable and paginated**, with the transcript stored in its own tables. Retention
  and erasure are first-order design inputs here, not an afterthought.
- **The unanswered-conversation follow-up is an ordinary notification.** When it fires, it goes
  through `RenderAndDispatchUseCase` with its own `eventType` and template, inheriting the consent
  gate, the delivery row and the retry ladder — the chat service publishes a fact and the notification
  service sends the mail.
- **A handler that consumes an event never rethrows** — the broker blind-redelivers in a hot loop; a
  relay failure is logged, and the persisted message is the source of truth a reconnecting client
  re-fetches.
- **No PII in an event payload or an audit row** (ADR-037). `chat.message.posted` carries the
  conversation id, the message id and the author id; **the body stays in the database**. This is the
  rail most easily broken here, because putting the text in the event is the obvious way to make
  relay cheap.
- **Shared types** (the conversation and message views, the socket envelope) under
  `libs/contracts/<cluster>/`; contracts stay framework-free.

## Open design questions

- **Whether the socket terminates at the gateway or at the new service.** Terminating at the gateway
  reuses the JWT guards and keeps one public ingress, at the cost of making the only HTTP deployable
  stateful and hard to drain. Terminating at the chat service keeps the gateway stateless and forces
  a second public ingress with its own authentication.
- **Agent identity.** Agents are `StaffUser`s with roles and permission codes, and a chat assignment
  is a work queue rather than a permission — the mapping between routing rules and the existing
  role/permission model is unresolved. Note that staff deactivation is itself a recorded gap in the
  root [`README.md` § Not built yet](../../../README.md#14-not-built-yet), which matters when a departing
  agent holds open conversations.
- **Guest conversations and identity merge.** A shopper who chats anonymously and then logs in should
  keep the transcript; merging an anonymous session into a customer is the same class of problem as a
  guest cart, and it is where consent and erasure get complicated.
- **Erasure semantics for a transcript.** Tombstone-only erasure nulls PII in place. A transcript is
  free text: nulling the customer's messages destroys the agent's side of a conversation that may be
  needed for a dispute, while keeping it leaks exactly what erasure exists to remove.
- **Build versus buy.** Intercom or Zendesk integrate in days; the reason to build is deep context
  (live order and inventory state in the agent view) and data ownership. Most shops should buy, and
  the honest version of this guide says so.
- **Scaling and connection limits** — a socket-bearing process has a hard concurrency ceiling and a
  drain problem on deploy that none of the six existing deployables has.

## Effort sketch

`subsystem-scale (5+ capabilities)` — a new deployable with its own persistence and boot, socket
transport with authenticated handshakes, the conversation and message domain, cross-instance fan-out,
presence, agent assignment and routing, an agent console, and a retention/erasure story for free-text
PII. Almost nothing is inherited: the notification service's machinery is built for one-way templated
sends, so the reuse is limited to the follow-up email. Of everything in this cluster, this is the one
where **buying is the reasonable default** and building is the exception that needs a business reason.
