---
title: Customer segments and tiers
cluster: Customer & Identity
effort: 2–3 capabilities
attaches_to:
  - apps/api-gateway/src/modules/auth/domain/customer.model.ts
  - apps/api-gateway/src/modules/auth/domain/consent-record.model.ts
---

# Customer segments and tiers

## Description

A **segment** is a named grouping of customers — "wholesale leads", "lapsed 90 days", "VIP", "opted
into the summer campaign". Some segments are **static** (an explicit membership list a marketer curates)
and some are **dynamic** (a rule evaluated over customer attributes and order history — "spent over
£500 in the last year"). A **tier** is the same thing with an ordering and attached benefits: bronze /
silver / gold is a ranked segment whose membership unlocks a discount, a loyalty multiplier, or free
shipping. Shopify's customer segments, Klaviyo's lists, and commercetools' customer groups all model
this as a first-class grouping the rest of the platform reads from.

This guide **owns the segment / group concept** for the whole system. A tier is a segment with benefits,
so the loyalty programme's tiers are segments defined here, not a parallel model. A later
customer-group-and-tiered-pricing capability (Pricing) and a later marketing-campaigns capability
(Notifications) both consume the segment defined here — they read membership, they do not re-invent the
grouping.

## Business needs

- **Marketing needs to address a cohort, not the whole book** — a campaign goes to "customers who bought
  a grill but no fuel", which is a segment, evaluated once and reused.
- **Pricing needs group scoping** — wholesale accounts pay a different price than retail walk-ins, which
  is a price rule scoped to a customer group.
- **Loyalty needs ranked tiers** — the difference between bronze and gold is membership plus a benefit,
  which is exactly a segment with an ordering.
- The threshold: a shop that treats every customer identically never needs this; the first "send this
  only to lapsed customers" or "wholesale sees cost-plus pricing" is where a grouping has to exist as a
  queryable thing rather than an ad-hoc filter re-written per feature.

## Attachment points in the current core

- **The `Customer` aggregate at
  `apps/api-gateway/src/modules/auth/domain/customer.model.ts`.** `Customer` is the party a segment groups.
  It is **gateway-owned domain state** (unlike every other aggregate, which lives in a microservice), so a
  segment that lives close to the customer belongs in the gateway `auth`/`customer-admin` area, and a
  segment that lives in a microservice is proposing a **second owner** for customer-derived data — a
  legitimate read-model split, but one to argue, not assume.
- **The `ConsentRecord` aggregate at
  `apps/api-gateway/src/modules/auth/domain/consent-record.model.ts`.** This is the load-bearing privacy
  anchor: `ConsentRecord` **owns marketing opt-in** — `marketingEmail` and `marketingSms` default
  **false** (opt-in), `transactionalEmail` defaults **true**. A segment used to *send marketing* must be
  filtered through consent; a segment used for a *transactional* purpose (order routing, pricing) is not.
  The notification service already reads consent through its `CONSENT_READER` / `CONSENT_CACHE` seam,
  cache-aside under the `CACHE_KEYS.notificationsConsent(customerId)` builder — a marketing send over a
  segment reuses exactly that gate.

## Implementation sketch

- **Aggregate: `CustomerSegment`** — the named grouping. It carries the name, a kind (`static` |
  `dynamic`), and for a dynamic segment the rule expression it evaluates. A **tier** is a `CustomerSegment`
  with a rank ordering and a benefit reference, so bronze/silver/gold are three ranked rows of the same
  aggregate — the loyalty and pricing guides reference these rather than defining their own.
- **Membership.** A static segment owns explicit `(segmentId, customerId)` rows — id-keyed, no PII in the
  join. A dynamic segment stores no membership rows; it is a rule evaluated on read (or materialised into a
  read model on a schedule) against `Customer` attributes and the `retail.order.placed` stream the event
  store already captures. A tombstoned (`status = 'deleted'`) customer is excluded from every dynamic
  rule by construction, because the rule filters on live status.
- **The marketing consent gate is mandatory, not optional.** A campaign send over a segment resolves each
  member's `ConsentRecord` through the notification `CONSENT_READER` and **drops** members without the
  relevant marketing flag — the same `skipped-no-consent` posture the notification gate already applies.
  A segment is *who you could contact*; consent is *whom you may*. The two are separate reads and the send
  is the intersection.
- **Events** ride `ris.events` — `customer.segment.assigned` / `customer.segment.removed`, carrying
  `customerId` + `segmentId` only. **No PII in the payload** (ADR-037): a segment membership is an id pair,
  never a name or an email.
- **Shared types** (the segment and tier views) under `libs/contracts/customer/`.
- **Cache.** A dynamic-segment membership read is a candidate for cache-aside under a **new**
  `CACHE_KEYS` builder in its own version segment (there is no segment builder today); a static membership
  is a direct read and needs none.

## Open design questions

- **Static vs. dynamic as one aggregate or two?** A static list and a rule-evaluated set behave
  differently on write (one is edited, one is recomputed). Modelling them as one `kind`-discriminated
  aggregate keeps the consumers uniform but complicates the membership read; two aggregates keep each
  simple but force every consumer to handle both.
- **Where a dynamic rule is evaluated** — live on every read (always fresh, expensive), materialised on a
  schedule (cheap, stale between runs), or streamed off the event store's `domain_event` log (fresh and
  cheap, but a new read-model to maintain). This is the same fact-table trade-off the demand-forecasting
  guide settles for inventory.
- **What a tier's benefit points at** — a discount rule, a loyalty multiplier, a shipping override. The
  segment owns *membership*; the benefit lives in whichever capability consumes the tier, and the coupling
  between them is the open contract.
- **Erasure of a static membership row.** A `(segmentId, customerId)` row is id-only, so it survives an
  erase as an inert id — but a marketer listing a static segment would see a tombstoned id with no name.
  Whether erase purges the membership rows or leaves the inert id is a retention call.

## Effort sketch

`2–3 capabilities` — the `CustomerSegment` aggregate with static/dynamic membership, the tier ranking on
top, and the consent-gated marketing read. It is bounded because it defines a grouping and a read; the
*benefits* a tier unlocks are each owned by the consuming capability (loyalty, pricing), not built here.
