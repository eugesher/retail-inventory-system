---
title: Refund to store credit
cluster: Returns & Refunds
effort: 1 capability
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/refund.model.ts
---

# Refund to store credit

## Description

**Refund to store credit** lets a refund's money land in the customer's **store-credit balance** instead
of going back to the original payment method. It is the cheapest refund a shop can offer — the money never
leaves the business — and the one customers most readily accept in exchange for instant availability and,
often, a small bonus. This capability is deliberately **thin**: it does not model what store credit *is*.
The store-credit ledger — the balance, how it is spent at checkout, how a spend becomes a `Payment` — is
owned wholesale by [gift-cards-and-store-credit.md](../order-management/gift-cards-and-store-credit.md). All this guide adds
is the **refund-path attachment**: a refund whose *destination* is that ledger rather than the gateway.

## Business needs

- **Cheapest refund** — store credit keeps the money in the business; it is the natural default a shop
  offers on a change-of-mind return where it is not obliged to return cash.
- **Instant settlement** — a gateway refund can take days to reach the customer's card; a store-credit
  refund is available the moment the return closes, improving the return experience at no cash cost.
- **Refund incentive** — offering *more* store credit than the cash refund (a 110% credit) nudges
  customers to keep the money in the shop; the capability must allow the credited amount to differ from
  the refunded amount.
- The threshold: the moment store credit exists as a tender at all
  ([gift-cards-and-store-credit.md](../order-management/gift-cards-and-store-credit.md)), making it a *refund destination* is
  the small, obvious next step.

## Attachment points in the current core

- **The `Refund` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/refund.model.ts`.** This is the whole attachment,
  and it is on the **orders side**, not in `returns/` — `Refund` lives in the orders module because every
  refund operation mutates `Payment`, and `Refund` is a sibling of `Payment` there (ADR-032). A return
  that closes with money owed *triggers* a `Refund`; it does not *own* one. So refund-to-store-credit
  attaches here, where the refund is issued, not in the returns module that requests it.
- **The `gatewayReference` field is the seam.** Today a `Refund` carries a `gatewayReference` — the opaque
  token the payment gateway returns when the money goes back to the card, `null` while `pending`. A
  store-credit refund does **not** call the card gateway; its destination is the store-credit ledger, so
  the natural extension is a **destination discriminator** on `Refund` (`to-original-payment` vs.
  `to-store-credit`) where the store-credit branch writes a ledger credit and records *its* reference
  instead of a processor token.
- **The store-credit ledger** ([gift-cards-and-store-credit.md](../order-management/gift-cards-and-store-credit.md)) — the
  destination, inherited whole. A store-credit refund is a **credit entry** on that append-only ledger,
  keyed to the customer, exactly the inverse of the debit a store-credit *spend* records. This guide
  contributes nothing to the ledger's design; it only points a refund at it.

## Implementation sketch

- **A refund destination.** Extend the refund path with a destination: `to-original-payment` (today's
  behaviour, via `PAYMENT_GATEWAY.refund`) or `to-store-credit` (a credit on the store-credit ledger).
  The `Refund` aggregate gains the discriminator; the Issue Refund use case branches on it.
- **The store-credit branch skips the gateway.** Instead of calling the card gateway, it appends a credit
  to the customer's store-credit balance and stamps the refund `issued` with a ledger reference in place
  of the processor's `gatewayReference`. The `Refund`'s status lifecycle (`pending → issued`/`failed`) is
  unchanged — only the effecting call differs.
- **The over-refund ceiling still holds.** The Issue Refund use case already enforces
  `amount ≤ Payment.amountMinor − Payment.refundedAmountMinor` — a store-credit refund is bound by the same
  ceiling, because it is still refunding *against a captured payment*; the money simply lands in a
  different place. The ceiling is not the ledger's concern.
- **The credited amount may differ from the refunded amount.** A 110%-credit incentive means the ledger
  credit is larger than the `Refund.amountMinor` that counts against the payment — the *bonus* is a
  promotional cost the shop absorbs, recorded on the ledger, not a larger refund against the payment. This
  keeps the payment-side accounting honest while allowing the incentive.
- **Erasure** follows the ledger's rule, which is [gift-cards-and-store-credit.md](../order-management/gift-cards-and-store-credit.md)'s
  to state: a customer-scoped balance is id-keyed and PII-free, so it survives a tombstone erase as a
  liability unless accounting forfeits it — this guide inherits that, it does not re-decide it.
- **Events** — the existing `retail.refund.issued` already fires; a store-credit refund may add the
  destination to the payload (ids and amounts only), and the ledger credit rides the store-credit
  capability's own events.

## Open design questions

- **Destination on the `Refund`, or a separate credit action?** A discriminator on `Refund` keeps one
  refund concept with two destinations (clean reporting: "all refunds"); a separate "issue store credit"
  action keeps `Refund` meaning strictly card-reversal and models the credit elsewhere. The former reuses
  the over-refund ceiling for free.
- **The incentive amount** — is a bonus-on-store-credit a fixed policy, a per-return staff choice, or a
  promotion the pricing side owns? Wherever it lives, the payment-side refund amount must stay the true
  figure against the payment.
- **Partial destinations** — can one refund split part to card and part to store credit? Real, but it
  turns the discriminator into a small breakdown and multiplies the reconciliation.

## Effort sketch

`1 capability` — a destination discriminator on `Refund`, a branch in the Issue Refund use case that
writes a ledger credit instead of calling the card gateway, and the reference bookkeeping. It is genuinely
small **because** it inherits the store-credit ledger from
[gift-cards-and-store-credit.md](../order-management/gift-cards-and-store-credit.md) wholesale and reuses the existing refund
lifecycle and over-refund ceiling unchanged — its only new surface is the refund's *destination*.
