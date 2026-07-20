# Extensions — how capabilities outside the core would attach

This folder answers one question, sixty-four times: **"if a business ever needed X, where would it
attach to this system?"** Each guide sketches a capability the core deliberately does not have —
naming the aggregates, ports, tables and routing keys it would extend, the entities and events it
would add, and the design decisions whoever picked it up would still have to make.

It is a forward-looking expansion reference, **not a record of rejected features**. Nothing here was
turned down; these are capabilities a *universal* retail core has no business carrying, because each
belongs to a vertical rather than to retail as such. A grocer needs lot and expiry tracking and a
bookshop never will.

## Three places record something that does not exist

They do not overlap, and [ADR-055](../adr/055-where-deliberately-unbuilt-work-is-recorded.md) is the
argument for why. One question routes a sentence to each:

| Where | Holds | Admission question |
| --- | --- | --- |
| [`README.md` § Not built yet](../../README.md#14-not-built-yet) | a gap in the **core**, whose seam is already in the code | *Does a named port, column, env var, cache-key builder or RPC already exist for it?* |
| **this folder** | a capability deliberately outside the universal core | *Is it retail-relevant but not retail-**required*** — something a vertical needs and the core does not? |
| [`spec/transition-windows.spec.ts`](../../spec/transition-windows.spec.ts) | an obligation somebody **owes**, queued behind a condition | *Is a future event supposed to make a specific person act by a specific date?* |

A guide is a **registry entry, not an obligation.** Nobody owes any of this: the condition may never
fire, and if it does, the work that fires it is standing in the guide's own subject matter. Guides
carry no review date and appear in no register.

A ledger row and a guide may cover the same ground — six pairs do, including tax, multi-tenancy and
notifier transports. When they do, **the row names the seam and links here; the guide describes the
capability and links back.** Neither restates the other.

## When a capability is actually built, its guide is deleted

Not annotated as done. Not kept as a record of what was once proposed. By the time the capability
ships, the content this file carried belongs in a
[`docs/implementation/`](../implementation/) walkthrough written against real code, and `git` keeps
the history.

The folder therefore only ever describes things that do not exist. That is what makes it readable at
a glance, and it is the one rule that stops it accumulating into an archive.

## How these guides are written

Every file in this folder except this one follows the contract below. It is enforced by
[`spec/extension-guides.spec.ts`](../../spec/extension-guides.spec.ts), which runs under
`yarn test:unit`.

### Front matter

```yaml
---
title: Product bundles
cluster: Product Catalog
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/
  - apps/retail-microservice/src/modules/cart/
---
```

| Key | Rule |
| --- | --- |
| `title` | The human-readable extension name. Matches the `# ` heading on the next line. |
| `cluster` | Exactly one of the nine cluster names below, verbatim. |
| `effort` | Exactly one of `1 capability`, `2–3 capabilities`, `subsystem-scale (5+ capabilities)`. |
| `attaches_to` | One or more repository-relative paths that exist **today**. Directories end in `/`. This is the machine-checked half of the `Attachment points` section. |

`attaches_to` is checked because it names the guides' realistic decay. The failure mode is **not**
that someone builds the capability and forgets this file — the person building it is reading this
file. It is that *"attaches to the `Order` aggregate at `<path>`"* quietly stops being true when a
module moves, months later, in a change that has nothing to do with extensions. A dead path fails
`yarn test:unit` on the commit that moves the module, when a human is already looking at that seam.

### Body — six sections, this order, these exact headings

```markdown
# <Human-readable extension name>

## Description

One or two paragraphs. What the extension is. Name a real product that ships it (Saleor, Vendure,
Shopify, Adobe Commerce, commercetools) when the comparison earns its place.

## Business needs

Bullets. Which verticals or business shapes require this, and the threshold at which the universal
core stops being enough.

## Attachment points in the current core

Bullets. The existing aggregates, ports, DI tokens, tables, routing keys and modules this would
extend or wrap, by current-state path — "the `Order` aggregate at
`apps/retail-microservice/src/modules/orders/domain/order.model.ts`". Every path named here that is
a module or file root belongs in `attaches_to`.

## Implementation sketch

Bullets or short prose. Entities to add, operations to add, events to emit. Ride the existing rails
by name: the per-module hexagon, ports and adapters, dotted `<service>.<aggregate>.<action>` routing
keys on the `ris.events` topic exchange, the `CACHE_KEYS` builder convention, append-only versus
mutable-aggregate classification.

## Open design questions

Bullets. The genuinely unresolved decisions whoever picks this up would have to make. If this
section is easy to write, the sketch above is probably too vague.

## Effort sketch

One line, matching the `effort` front matter value, with half a sentence saying why.
```

`Open design questions` is mandatory for a reason: **a sketch with no open questions has not been
thought about, it has been summarised.**

### The five rails a sketch must honour

A sketch that contradicts one of these is wrong, not creative.

| Rail | What a sketch must say | Source |
| --- | --- | --- |
| Events | *"would emit `<service>.<aggregate>.<action>` on the existing `ris.events` topic exchange"* — never a new transport, never a new broker | [ADR-008](../adr/008-rabbitmq-via-libs-messaging.md), [ADR-020](../adr/020-rabbitmq-as-inter-service-bus.md), [ADR-035](../adr/035-event-store-firehose-topic-exchange.md) |
| Shared types | new cross-service types go under `libs/contracts/<cluster>/`, never duplicated per service | [ADR-005](../adr/005-split-shared-common-into-bounded-libs.md) |
| Cache | a cached read names a `CACHE_KEYS` builder with its version segment; no key literal in `apps/` | [ADR-016](../adr/016-cache-aside-generalized.md), [ADR-022](../adr/022-cache-keys-tenant-and-schema-version.md) |
| Layout | a new service is `apps/<name>/`; a new module is a per-module hexagon whose Nest module file is its composition root | [ADR-018](../adr/018-nestjs-monorepo-apps-and-libs.md), [ADR-004](../adr/004-adopt-hexagonal-architecture-per-service.md), [ADR-041](../adr/041-nest-module-as-the-module-composition-root.md) |
| Privacy | no PII in an event payload or an audit row; erasure is tombstone-only; consent is default-transactional-on, default-marketing-off | [ADR-037](../adr/037-consent-record-and-tombstone-erasure.md) |

### The source of truth is the code

**Every path, port symbol, DI token, table name, column, routing key and aggregate name a guide
states must be read out of the source before it is written down.** Not out of the root `README.md`,
and not out of [`docs/implementation/`](../implementation/) — those notes describe a capability at
the moment it shipped, they are explicitly point-in-time, and several have carried counts and names
the code moved past. They are good evidence of *why* a thing was built as it was; they are not
evidence that it is still shaped that way.

So: `ls` the directory, `grep` the token, open the model file.

### Tone

Forward-looking, never backward-looking. Write *"a business selling perishables needs lot and expiry
tracking; here is where it attaches"*, never *"we decided not to build this"*. Nothing here may read
as a changelog or a scope negotiation.

---

## Contents

### Product Catalog

| Guide | Hook |
| --- | --- |
| brand-entity.md | |
| configurable-products-option-dependencies.md | |
| digital-good-entitlements.md | |
| dynamic-attribute-schemas.md | |
| multi-locale-translation-tables.md | |
| product-bundles.md | |
| product-relations-and-recommendations.md | |
| subscriptions-and-selling-plans.md | |
| supplier-and-vendor.md | |

### Inventory

| Guide | Hook |
| --- | --- |
| abc-classification.md | |
| bin-aisle-shelf.md | |
| consigned-vendor-managed-inventory.md | |
| demand-forecasting-and-safety-stock.md | |
| expiry-fifo-rotation.md | |
| in-transit-as-separate-location.md | |
| lot-batch-serial-tracking.md | |
| transfer-order-documents.md | |

### Order Management

| Guide | Hook |
| --- | --- |
| b2b-quote-po-credit-terms.md | |
| bnpl-state-machines.md | |
| dropshipping-vendor-routing.md | |
| fraud-and-risk-scoring.md | |
| gift-cards-and-store-credit.md | |
| marketplace-seller-payouts.md | |
| replacement-orders-distinct-entity.md | |
| shipping-rate-engine.md | |
| subscriptions-recurring-orders.md | |
| tax-computation-engine.md | |

### Customer & Identity

| Guide | Hook |
| --- | --- |
| b2b-company-hierarchies.md | |
| crm-tags.md | |
| customer-segments-and-tiers.md | |
| loyalty-programs.md | |
| mfa-and-household-grouping.md | |
| social-login-providers.md | |
| wishlists.md | |

### Returns & Refunds

| Guide | Hook |
| --- | --- |
| advance-replacement.md | |
| exchanges-as-first-class-entity.md | |
| refund-to-store-credit.md | |
| repair-workflows.md | |
| return-fraud-scoring.md | |
| vendor-rmas.md | |

### Pricing & Promotions

| Guide | Hook |
| --- | --- |
| b2b-contract-pricing.md | |
| coupons-and-discount-codes.md | |
| currency-conversion.md | |
| customer-group-and-tiered-pricing.md | |
| discounts-and-promotions.md | |
| dynamic-ai-pricing.md | |
| msrp-vs-sale-price.md | |
| tax-rate-tables.md | |

### Notifications & Events

| Guide | Hook |
| --- | --- |
| ab-template-testing.md | |
| abandoned-cart-automation.md | |
| in-app-inbox-feed.md | |
| live-customer-messaging.md | |
| marketing-campaigns-and-segmentation.md | |
| push-device-token-registration.md | |
| scheduled-batch-newsletters.md | |
| webhook-subscription-management-ui.md | |

### Staff & Access Control

| Guide | Hook |
| --- | --- |
| approval-workflows.md | |
| dynamic-abac-policies.md | |
| mfa-enforcement.md | |
| scoped-tenant-aware-roles.md | |
| session-device-management.md | |
| sso-saml-oidc-federation.md | |
| staff-scheduling-and-shifts.md | |

### Physical Retail

| Guide | Hook |
| --- | --- |
| physical-retail-pos-terminals.md | |
