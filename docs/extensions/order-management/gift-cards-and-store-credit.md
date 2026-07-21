---
title: Gift cards and store credit
cluster: Order Management
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/payment.model.ts
  - apps/retail-microservice/src/modules/orders/domain/refund.model.ts
---

# Gift cards and store credit

## Description

Store credit and gift cards are **a tender that is not a card** — a balance the shop itself owns,
spendable at checkout like any other payment method. A gift card is a bearer instrument (redeemed by a
code); store credit is a customer-scoped balance (redeemed by whoever is signed in). Shopify, Adobe
Commerce and Vendure all ship both, and both reduce to the same question: *what is a balance, and how
does spending it become a `Payment`?*

This guide **owns the store-credit ledger** — the shape every later capability that touches an internal
balance builds on (the returns cluster's refund-to-store-credit is the first). It also **owns "a tender
that is not a card"**: the argument that `Payment.method` is an opaque string and the `PAYMENT_GATEWAY`
seam already models an arbitrary tender, so a non-card payment needs no new payment column. The BNPL
guide links here for that argument rather than restating it.

## Business needs

- **Gift cards** are a direct revenue line (cash today, fulfilment later) and a standard gifting
  mechanism; a shop without them cedes the occasion-purchase market.
- **Store credit** is the cheapest refund — money that stays in the business — and the natural
  settlement for goodwill gestures, loyalty payouts and returns the customer would rather not wait for
  a card reversal on.
- **Partial tender** (credit covers part, a card covers the rest) is the common case, not the
  exception, so the model cannot assume one payment per order.
- The threshold: a shop that only ever takes a single card charge per order does not need this; the
  first gift card sold, or the first "refund to store credit" offered, is where a balance has to become
  first-class.

## Attachment points in the current core

- **The `Payment` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/payment.model.ts`.** `method` and
  `gatewayReference` are **opaque tokens** the model stores but never parses — a redemption is a
  `Payment` row with `method = 'store-credit'` (or `'gift-card'`). The order header already tolerates
  the money arriving from a non-card source; nothing in `Payment` assumes a processor.
- **The `PAYMENT_GATEWAY` port** (`application/ports/payment-gateway.port.ts`) — `authorize` already
  takes an opaque `method` token and returns an opaque reference. An internal-tender adapter satisfies
  the same interface by debiting the ledger instead of calling a processor, so redemption rides the
  existing seam with **no use-case change** (the port's own comment names this swap-in shape).
- **The `Refund` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/refund.model.ts`** — a refund *to* store credit
  is a refund whose destination is the ledger rather than the original `gatewayReference`; the returns
  cluster's `refund-to-store-credit` builds on this.

## Implementation sketch

- **The balance is an append-only ledger, not a mutable number** — the `price` and `stock_movement`
  precedent. A `StoreCreditAccount` (per customer) or `GiftCard` (per code) owns an append-only
  `StoreCreditEntry` ledger of **signed** amounts: issuance `+`, redemption `−`, expiry `−`,
  adjustment either. The **balance is a derived sum**, never stored — exactly the discipline that keeps
  `StockLevel.available` a getter. This is the shape later guides inherit.
- **Currency is fixed at issuance and never converted silently.** `Order.currency` is immutable and no
  currency default is a literal — three DI tokens (`RETAIL_DEFAULT_CURRENCY`, `CATALOG_DEFAULT_CURRENCY`,
  `CATALOG_GATEWAY_DEFAULT_CURRENCY`) read one `DEFAULT_CURRENCY` var deliberately. So a balance is
  **single-currency**: credit issued in EUR carries `currency: 'EUR'` and can only tender a EUR order.
  Cross-currency redemption is an explicit FX step, never an implicit one — a silent conversion would
  bake the wrong unit into an immutable order forever.
- **Redemption is a money-moving write** and joins the request-level idempotency set (ADR-036): the key
  guards against a double-debit when a checkout retries. Every ledger append is version-checked OCC
  (ADR-045) against the account, so two concurrent redemptions cannot both spend the last unit — the
  no-oversell discipline, applied to money.
- **Issuance events** ride `ris.events` — `retail.gift-card.issued`, `retail.store-credit.granted`,
  `retail.store-credit.redeemed`. **No PII in the payload** (ADR-037): a gift-card code is a bearer
  secret and a balance is tied to a `customerId`, so events carry ids and amounts, never the recipient's
  email.
- **Shared types** (the balance view, the redemption command) under `libs/contracts/<cluster>/`.

## Open design questions

- **Tender ordering with mixed payments.** When credit covers part of an order, which tender is
  authorized first, and what happens if the card leg then declines — is the credit debit rolled back, or
  held? The order's totals are immutable, so the split has to be decided at place time.
- **Gift-card fraud surface.** A bearer code is guessable if the space is small; the code format, rate
  limiting and lookup-hardening are a real security decision, not a schema one.
- **Expiry policy** is jurisdiction-regulated (some regions forbid gift-card expiry outright), so
  whether an `expiry` entry is even legal is a per-market call.
- **Is store credit refundable to cash?** If a customer can convert credit back to a card, the ledger
  gains a withdrawal path with its own fraud and accounting implications.

## Effort sketch

`subsystem-scale (5+ capabilities)` — the ledger aggregate(s), the internal-tender adapter, redemption
as a `Payment`, issuance, expiry, and the mixed-tender split at checkout. The ledger shape it settles is
the foundation the returns cluster's refund-to-store-credit reuses, which is part of why it is a
subsystem rather than a single capability.
