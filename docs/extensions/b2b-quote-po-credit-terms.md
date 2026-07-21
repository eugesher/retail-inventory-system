---
title: B2B quotes, purchase orders and credit terms
cluster: Order Management
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/order.model.ts
  - apps/retail-microservice/src/modules/orders/domain/payment.model.ts
---

# B2B quotes, purchase orders and credit terms

## Description

B2B selling breaks two assumptions the consumer checkout is built on: that a price is fixed before the
buyer arrives, and that money is captured at (or near) the sale. A business buyer requests a **quote**,
negotiates it, approves it against a **purchase order**, and pays on **credit terms** (net-30, net-60)
*after* the goods ship. Shopify's B2B, Adobe Commerce B2B and commercetools all model a company account,
a negotiable quote and deferred-payment terms as the core of the shape.

This guide **owns the B2B account, quote and credit-terms model** — the party and lifecycle that the
later B2B guides build on. A B2B-company-hierarchies guide will add a tree of accounts on top of this
party, and a B2B-contract-pricing guide will add account-scoped price rules; both inherit the
`BusinessAccount` defined here rather than reinventing it.

## Business needs

- **Companies buy as organisations, not individuals** — many buyers, one account, one set of terms, one
  invoice stream. The consumer `Customer` cannot carry that.
- **Negotiated pricing** — a quote is a proposed order whose prices and quantities move during
  negotiation, unlike a placed `Order` that is frozen at checkout.
- **Purchase-order approval** — a buyer's own PO number and internal sign-off gate the order; the shop
  records the PO reference against the eventual order.
- **Credit terms** — net-30 means the shop ships now and is paid later, which decouples capture from
  fulfilment entirely.
- The threshold: a consumer-only shop never needs this; the first wholesale account that asks for an
  invoice instead of paying by card is where quotes and terms have to exist.

## Attachment points in the current core

- **The `Order` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/order.model.ts`.** A quote is a **pre-order with a
  different immutability story**: `Order` is frozen at placement (every money field `readonly`), whereas
  a quote is mutable during negotiation and only becomes an immutable `Order` on acceptance. The quote is
  the B2B analogue of the mutable `Cart`; the order is still the frozen record it converts into.
- **The `Payment` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/payment.model.ts`.** Credit terms mean a **capture
  that is not at ship time**: ADR-031 ties capture to shipping, but net-30 requires the order to ship
  (`fulfillmentStatus` advances) while the payment axis stays uncaptured, with capture happening on
  invoice settlement days later. The payment axis is already orthogonal to fulfilment (ADR-028 §2), so
  this is a decoupling the model permits, not one it forbids.

## Implementation sketch

- **Aggregate: `BusinessAccount`** — the buyer organisation. It carries the authorised buyers, the
  credit limit, the payment terms (net-30/60), and a link to the individual `Customer`s who transact on
  its behalf. This is the party the later B2B guides hang hierarchy and contract pricing off of.
- **Aggregate: `Quote`** — a mutable, negotiable pre-order with a lifecycle `draft → sent → accepted →
  converted` (plus `expired` / `rejected`). It carries proposed lines, quantities and prices; it is
  version-checked with the one OCC protocol (ADR-045). On acceptance it converts to an `Order` exactly
  as a cart does — the order snapshots the agreed prices, and from then on is immutable.
- **Credit-terms capture ladder.** Shipping a net-terms order advances fulfilment without capturing;
  an invoice is raised, and capture happens when the invoice is settled (or is written off after the
  term expires). A terms-aware capture path replaces the ship-triggered capture for these orders,
  respecting the capture-claim discipline (ADR-052) so a settlement retry never double-captures. Against
  the credit limit, the OCC discipline prevents two orders from both consuming the last of the limit.
- **PO reference** is stored on the order (an opaque buyer-supplied string, never parsed), the way
  `gatewayReference` is opaque.
- **Events** ride `ris.events` — `retail.quote.sent`, `.accepted`, `retail.b2b-account.registered`,
  `retail.invoice.raised`, `retail.invoice.settled`. **No PII in the payload** (ADR-037): a buyer's
  contact details stay out of the event, ids and amounts only.
- **Shared types** (the account, quote and terms views) under `libs/contracts/<cluster>/`.

## Open design questions

- **How immutable is an accepted quote before it converts?** If a buyer can accept and then the price
  ledger moves before conversion, which price wins — the quoted one (needs a snapshot on the quote) or
  the live one (breaks the negotiation)? This is the crux of the quote's immutability story.
- **Credit-limit enforcement point** — is the limit checked at quote acceptance, at order placement, or
  at ship? Each choice trades off buyer certainty against platform risk.
- **What raises and settles the invoice** — is invoicing in-scope for retail, or a handoff to an
  external AR/ERP system through a port? Net-terms accounting can be a whole external integration.
- **Multi-buyer approval** — does a PO need an internal approver distinct from the order placer, and
  does that approval live here or in a staff-side approval-workflow space?

## Effort sketch

`subsystem-scale (5+ capabilities)` — the `BusinessAccount` party, the negotiable `Quote` aggregate and
its lifecycle, quote-to-order conversion, credit-limit tracking, and the terms-based capture ladder with
invoicing. It is the foundation two later B2B guides build on, which is part of why it is a subsystem
rather than a single capability.
