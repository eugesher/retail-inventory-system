---
title: A/B template testing
cluster: Notifications & Events
effort: 2–3 capabilities
attaches_to:
  - apps/notification-microservice/src/modules/notifications/domain/notification-template.model.ts
  - apps/notification-microservice/src/modules/notifications/application/ports/template-renderer.port.ts
---

# A/B template testing

## Description

**A/B template testing** sends two (or more) variants of the same message to disjoint slices of the
recipients and measures which performs better — a different subject line, a different call to action,
a different layout — then promotes the winner. Klaviyo, Braze and Mailchimp all ship this as a
first-class feature over their template systems, because the difference between a 12% and an 18%
open rate on a recurring send is worth more than most feature work.

The distinction this guide must keep straight: an A/B test varies **the template**, never the
**renderer**. Exactly one file in the system imports the templating library, behind
`TEMPLATE_RENDERER`; a variant is a different template row rendered by the same engine, not a second
engine or a second binding.

## Business needs

- **Copy is guesswork until measured** — subject lines and calls to action are the highest-leverage,
  lowest-cost thing to optimise in outbound messaging, and only a controlled split measures them.
- **Compounding returns on recurring sends** — a newsletter that goes out weekly earns the winning
  variant's margin every week thereafter.
- **Evidence over seniority** — a test result settles a copy argument that would otherwise be settled
  by whoever is most senior in the room.
- The threshold: a shop sending a handful of transactional templates has nothing to test and not
  enough volume for significance; the first *recurring, high-volume* marketing send is where a split
  starts paying for itself.

## Attachment points in the current core

- **`NotificationTemplate` at
  `apps/notification-microservice/src/modules/notifications/domain/notification-template.model.ts`.**
  The registry is keyed `(eventType, channel, locale)` and **versioned**: an edit does not rewrite a
  row, it appends a brand-new row at `version + 1` via `withNextVersion`, so the full edit history is
  retained. `findLatestActive` resolves the **highest-`version` `active` row** for the key — one
  winner, deterministically. `active` is the soft-delete flag (never a `deletedAt`), so a template is
  taken out of resolution by being deactivated.
  **This is the exact seam an A/B test bends**: the model already stores *several* rows per key and
  already picks one; a test needs it to pick *one of several, per recipient*, rather than always the
  highest. Note that `version` here is the **business** version, not an OCC token — the notification
  tables ship no optimistic-lock column at all.
- **`TEMPLATE_RENDERER` at
  `apps/notification-microservice/src/modules/notifications/application/ports/template-renderer.port.ts`.**
  A single synchronous `render(source, context)` seam; the Handlebars import is confined to the
  `infrastructure/render/` adapter. A variant supplies a different `source`; **the port and its
  binding do not change**, and HTML-escaping stays the renderer's default.
- **The template resolution step in `RenderAndDispatchUseCase`** (step 1). It calls
  `findLatestActive(eventType, channel, locale)` and, on a `null`, warns and returns *without*
  persisting a row. Variant selection is an extension of this single call site — the one place that
  decides which template a dispatch uses.
- **`NotificationDelivery`** — the measurement substrate. Every send already writes a row carrying
  its `templateId`, so "which variant did this recipient get?" is already recorded; what is missing
  is the *outcome* side of the funnel, not the assignment side.
- **The reserved `CACHE_KEYS.notificationsTemplate(eventType, channel, locale)` and
  `notificationsTemplatePrefix(...)` builders.** They exist in `libs/cache/cache-keys.ts` and
  **nothing calls them** — the template read is uncached today. A per-dispatch variant lookup makes
  that hot path hotter, and these builders are where a cache-aside would go. Note the key shape:
  it is keyed by `(eventType, channel, locale)`, which is the *registry* key, not a variant key —
  caching a resolution that is now per-recipient needs the key widened or the cache scoped to the
  candidate *set* rather than the winner.
- **Locale is already part of the key, and always defaults.** The pipeline falls back to `en-US`
  because producer events ship `customerLocale: null` — a gap the root
  [`README.md` § Not built yet](../../README.md#14-not-built-yet) already records. A test whose
  variants differ by locale would be measuring the gap, not the copy.

## Implementation sketch

- **A variant is a template row, tagged.** Extend the registry key with an optional variant label so
  `(eventType, channel, locale, variant)` can hold `A` and `B` as separate, independently-versioned
  rows. This keeps every existing invariant — versioning, `active`, the channel-specific subject
  rule — and adds one dimension. A template with no variant label is the untested default.
- **Assignment is deterministic, never random per send.** Hash the stable recipient id (with the
  experiment id as salt) into a bucket. The same customer must land in the same arm across a
  redelivery, a retry, and a resend — a coin flip per dispatch corrupts the measurement and, worse,
  sends the same person both variants.
- **Selection replaces the resolution call, and nothing else.** An `Experiment` (the key under test,
  the arms, the split, the state) is read at step 1; everything downstream — render, consent gate,
  delivery row, dedupe, retry — is untouched. A failure to resolve an experiment falls back to
  `findLatestActive`, so a broken test degrades to the current behaviour rather than to no send.
- **Measurement needs an outcome the system does not have.** Assignment is already recorded on the
  delivery row; opens and clicks are **not** — they arrive from the transport, and the ESP webhook
  ingestion that would carry them is itself a recorded gap (see the same
  [`README.md`](../../README.md#14-not-built-yet) section, and the `notification.delivery.record-outcome`
  RPC that already exists behind it). Until an outcome lands, a test can only measure send-side
  facts. **This dependency is the guide's real cost, not the split.**
- **Promotion is an ordinary registry edit.** Declaring a winner authors the winning body as the next
  version of the unlabelled default and deactivates the arms — reusing `withNextVersion` and
  `deactivate`, no new write path.
- **Events ride `ris.events`** (`notification.experiment.concluded`) — no new exchange, no PII.
- **Shared types** (the experiment view, the variant-tagged template view) under
  `libs/contracts/<cluster>/`.

## Open design questions

- **Variant as a key dimension vs. a separate `TemplateVariant` entity.** Widening the natural key
  keeps one model and one resolution path but makes every existing query variant-aware; a separate
  entity keeps the registry untouched at the cost of two places that mean "the template to send".
- **What is significant, and who decides.** A split with no stopping rule is a way to ship whichever
  arm happened to lead; whether the system computes significance or merely reports counts determines
  whether it is a testing feature or a reporting one.
- **Interaction with transactional sends.** Testing an order confirmation is legitimate (subject-line
  clarity affects support volume) but riskier than testing a newsletter — whether transactional keys
  are testable at all is a policy call, and `TRANSACTIONAL_EVENT_TYPES` is where that line is already
  drawn for consent.
- **Holdout groups** — measuring a send against *not sending* requires an arm that produces no
  delivery row, which the current model has no way to express (a `skipped-no-consent` row means
  something else entirely).
- **Whether the template read gets a cache at the same time.** Per-recipient selection multiplies the
  registry read; adopting the reserved builders is optional for the test and near-mandatory at
  campaign volume.

## Effort sketch

`2–3 capabilities` — a variant dimension on the registry, deterministic assignment plus an
experiment aggregate at the single resolution call site, and promotion. It is bounded **because** the
registry is already multi-row-per-key with a deterministic winner, the renderer is already behind a
port that does not move, and the delivery row already records which template was used. The honest
caveat is that the *measurement* half depends on delivery outcomes the core does not yet ingest, so
a test built today reports sends, not opens.
