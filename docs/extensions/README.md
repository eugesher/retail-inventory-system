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
| [brand-entity.md](brand-entity.md) | Brand as an orthogonal facet, not a category-tree node; logo reuses the polymorphic `MediaAsset`. |
| [configurable-products-option-dependencies.md](configurable-products-option-dependencies.md) | Cross-option rules above the flat variant axis — pre-generate variants or evaluate rules at add-to-cart. |
| [digital-good-entitlements.md](digital-good-entitlements.md) | Shipment-less fulfilment for non-physical variants; the entitlement is delivered through the notification pipeline. |
| [dynamic-attribute-schemas.md](dynamic-attribute-schemas.md) | Typed, per-category attributes replacing the untyped `optionValues` map; reshapes the contract views. |
| [multi-locale-translation-tables.md](multi-locale-translation-tables.md) | Per-locale translation rows filling the `customerLocale: null` seam the notification producers already ship. |
| [product-bundles.md](product-bundles.md) | Kits and bundles over the `variantId` backbone; the open call is when to explode a bundle into cart lines. |
| [product-relations-and-recommendations.md](product-relations-and-recommendations.md) | Curated product-to-product graph on the reserved `catalogProduct*` cache builders; computed recommendations stay out. |
| [subscriptions-and-selling-plans.md](subscriptions-and-selling-plans.md) | Owns the plan definition and its relationship to the `price` ledger; the recurrence engine lives in order management. |
| [supplier-and-vendor.md](supplier-and-vendor.md) | Owns the Supplier / Vendor party in a new Procurement service; four later guides build on it. |

### Inventory

| Guide | Hook |
| --- | --- |
| [abc-classification.md](abc-classification.md) | Pareto A/B/C tiers scored off the `stock_movement` fact table; a read-side projection that touches no counter. |
| [bin-aisle-shelf.md](bin-aisle-shelf.md) | Sub-location slotting below `StockLocation` — a bin is a pick detail, not a shipping origin, so it stays an axis under the level. |
| [consigned-vendor-managed-inventory.md](consigned-vendor-managed-inventory.md) | Adds an ownership axis to stock so a supplier can own on-hand units; title transfers at sale. Builds on the supplier party. |
| [demand-forecasting-and-safety-stock.md](demand-forecasting-and-safety-stock.md) | Owns the "ledger is the fact table" argument; forecasts demand and computes safety stock as a read model over `stock_movement`. |
| [expiry-fifo-rotation.md](expiry-fifo-rotation.md) | Expiry dates on lots and a pluggable FEFO/FIFO allocation policy; a small delta on top of lot tracking. |
| [in-transit-as-separate-location.md](in-transit-as-separate-location.md) | Models the dispatch-to-receipt gap as a virtual `StockLocation`, reusing the `dropship-virtual` precedent. |
| [lot-batch-serial-tracking.md](lot-batch-serial-tracking.md) | Splits the running totals by a lot/batch/serial axis; re-keys reservations and widens the append-only ledger. |
| [transfer-order-documents.md](transfer-order-documents.md) | Wraps the atomic two-`adjustment` transfer in a draft→dispatched→received document with an in-transit period. |

### Order Management

| Guide | Hook |
| --- | --- |
| [b2b-quote-po-credit-terms.md](b2b-quote-po-credit-terms.md) | Owns the B2B account, negotiable quote and net-terms model; a quote is a mutable pre-order, credit terms decouple capture from ship. |
| [bnpl-state-machines.md](bnpl-state-machines.md) | Installment tender on the existing `PAYMENT_GATEWAY` seam; the async provider confirmation reuses ADR-052's `CAPTURING` capture claim. |
| [dropshipping-vendor-routing.md](dropshipping-vendor-routing.md) | Routes a `Fulfillment` to a vendor-backed `dropship-virtual` location; builds on the supplier party, ships nothing from own stock. |
| [fraud-and-risk-scoring.md](fraud-and-risk-scoring.md) | Owns the risk-scoring seam — an external `RISK_SCORING_GATEWAY` port at place-time that can allow, hold or block, carrying no PII. |
| [gift-cards-and-store-credit.md](gift-cards-and-store-credit.md) | Owns the store-credit ledger (append-only, derived balance) and "a tender that is not a card" riding opaque `Payment.method`. |
| [marketplace-seller-payouts.md](marketplace-seller-payouts.md) | One buyer capture fans out into an append-only per-seller `Payout` ledger minus commission; builds on the supplier-as-seller party. |
| [replacement-orders-distinct-entity.md](replacement-orders-distinct-entity.md) | Owns the replacement-as-a-new-`Order` argument — a zero-value order linked by `replacesOrderId`, reusing the whole order subsystem. |
| [shipping-rate-engine.md](shipping-rate-engine.md) | Fills the waiting `shippingTotalMinor` seam via a `SHIPPING_RATE_ENGINE` port rating the destination `Address` at checkout. |
| [subscriptions-recurring-orders.md](subscriptions-recurring-orders.md) | The recurrence engine generating an `Order` per cycle and running the dunning ladder; quotes the plan/engine boundary from the catalog side. |
| [tax-computation-engine.md](tax-computation-engine.md) | Owns the tax call-out seam — an external `TAX_ENGINE` writing the captured-not-computed `taxAmountMinor`; fills the `TaxCategory`-is-a-label gap. |

### Customer & Identity

| Guide | Hook |
| --- | --- |
| [b2b-company-hierarchies.md](b2b-company-hierarchies.md) | A materialized-path tree of account nodes (the `Category` shape) above the B2B party; credit limits and contract-price scope roll up the tree. |
| [crm-tags.md](crm-tags.md) | Staff-applied controlled-vocabulary labels on a customer; the label stays PII-free so an audited or emitted tag never re-seeds the erase. |
| [customer-segments-and-tiers.md](customer-segments-and-tiers.md) | Owns the segment/tier grouping — static and dynamic; a marketing send over a segment is gated on `ConsentRecord` opt-in. |
| [loyalty-programs.md](loyalty-programs.md) | An append-only points ledger with a derived balance, accrued off `retail.order.placed`; tiers are segments, redemption is tender-or-discount. |
| [mfa-and-household-grouping.md](mfa-and-household-grouping.md) | Owns customer-facing opt-in MFA wrapping the login use case, plus household grouping; draws the customer-vs-staff MFA line. |
| [social-login-providers.md](social-login-providers.md) | OAuth/OIDC login replacing the password seam and reusing `TOKEN_SERVICE`; adds a `FederatedIdentity` link and the null-password invariant call. |
| [wishlists.md](wishlists.md) | A durable cart-shaped list minus checkout — no price snapshot, no OCC, no TTL, no reservation; live-priced and dropped on erase. |

### Returns & Refunds

| Guide | Hook |
| --- | --- |
| [advance-replacement.md](advance-replacement.md) | Ships the substitute before the return arrives — an exchange whose outbound leg fires first, gated by a payment hold a deadline sweep captures on non-arrival. |
| [exchanges-as-first-class-entity.md](exchanges-as-first-class-entity.md) | Owns the exchange / replacement / advance-replacement split; one aggregate binding an inbound RMA to an outbound `Order` so the swap can't drift apart. |
| [refund-to-store-credit.md](refund-to-store-credit.md) | A refund whose destination is the store-credit ledger, not the card gateway — a destination discriminator on `Refund`, inheriting the ledger wholesale. |
| [repair-workflows.md](repair-workflows.md) | A `repair` disposition that leaves and comes back — non-terminal, deferring a line's final restock or return-to-customer until the repair closes. |
| [return-fraud-scoring.md](return-fraud-scoring.md) | Scores a return at Open against the inherited `RISK_SCORING_GATEWAY` block/hold/allow seam; the score request and its events stay id-only. |
| [vendor-rmas.md](vendor-rmas.md) | The outbound mirror of a customer return — units routed back to the supplier that supplied them, with a supplier-facing lifecycle and a ledger movement. |

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
