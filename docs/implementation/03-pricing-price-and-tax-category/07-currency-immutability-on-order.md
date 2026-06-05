# 07 — Currency on the price ledger seeds an immutable order currency

This document is **forward-looking**. It records a contract the pricing capability
deliberately *shapes* but does not *own*: how the `currency` carried on each
`Price` row becomes the seed of a future order's header currency, and why that
order currency must then be immutable for the life of the order.

Nothing here changes pricing code. It exists so that whoever builds the cart /
order-placement capability inherits the reasoning instead of re-deriving it — and
so they do not accidentally model currency in a way that re-opens a question the
price ledger already answered.

It builds on the ledger model in
[02 — Price domain and append-only history](02-price-domain-and-append-only-history.md)
and the resolution policy in
[05 — Set / Schedule / Select Applicable Price](05-select-applicable-price.md), and
it anticipates the order side governed by
[ADR-013](../../adr/013-order-aggregate-and-cross-service-confirm.md).

## 1. Where currency lives today

A `Price` is scoped on exactly **`(variantId, currency)`** and there is no other
scope axis ([ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md)).
Currency is not a formatting hint hung off an amount — it is half of the ledger's
identity. Two facts follow directly:

- **`amountMinor` is meaningless without its `currency`.** `4999` is `$49.99` only
  because the row says `USD`; the same integer under `JPY` would be ¥4999. The
  amount and its currency travel together on every `PriceView`, never apart.
- **A variant can carry several currency ledgers at once.** `(variant 1, USD)` and
  `(variant 1, EUR)` are independent append-only timelines, each with its own
  at-most-one-open-row invariant. Selecting a price is therefore always a
  `(variantId, currency, asOf)` question — currency is a required input, not a
  derived one. The gateway read DTO encodes this by defaulting `?currency` to the
  configured `DEFAULT_CURRENCY` (`USD`) at the edge rather than leaving it absent.

So the system already has a single, unambiguous source for "what currency is this
variant priced in, right now" — and it is per variant, not global.

## 2. The order side, and why currency has to freeze

An order is placed at a moment in time. The capability that places it will, for
each line, resolve the variant's **applicable price** — the deterministic
`(variantId, currency, asOf=place-time)` → single `Price` answer that
[05](05-select-applicable-price.md) already implements (highest `priority`, then
latest `validFrom`). That resolved row's `amountMinor` is what the customer agrees
to pay, and its `currency` is the currency they agree to pay it in.

Once the order exists, both must **stop tracking the ledger**:

- **The amount is captured, not referenced.** The price ledger keeps changing —
  that is its whole point (a price *change* is a new row plus a close of the
  predecessor). An order that re-resolved its line prices on every read would
  silently re-total itself whenever someone repriced the variant. The placed order
  stamps the resolved `amountMinor` onto the line and never looks back.
- **The currency is captured once, at the header, and is then immutable.** Every
  line on one order must settle in one currency — you cannot sum `USD` and `EUR`
  line amounts into a single order total without a conversion the system does not
  model. So the order header carries a single `currency`, set from the prices
  resolved at place-time, and **frozen**: no later mutation, no re-derivation from a
  ledger that may have grown a new currency for the variant in the meantime.

This is the **multi-currency threshold**. As long as the storefront prices and
sells in one currency, the header currency is effectively a constant and the
freeze is invisible. The instant a second currency ledger goes live for any sold
variant, the freeze is what stops a half-placed order from straddling two
currencies — and it is *already* enforceable, because currency was modelled as
part of price identity from day one rather than bolted on later.

## 3. What this capability owns, and what it does not

This pricing capability owns the **left** side of that contract and deliberately
stops at the boundary:

- It owns the `(variantId, currency)` scope, the per-currency append-only
  timelines, and the `(variantId, currency, asOf)` → single-price resolution. These
  are exactly the inputs an order needs to stamp a line and a header currency.
- It does **not** own an `Order`, an `Order.currency` column, or any place-time
  capture. There is no order-side code here, and pricing has no opinion on order
  lifecycle — it exposes `catalog.price.select` and lets the caller decide what to
  do with the answer.

That split is intentional. Pricing is a read the order side *calls*; it is not a
writer into the order aggregate. The forward contract is therefore expressible as
two obligations on the future capability, with no change required here:

1. **Resolve, then capture.** Call Select Applicable Price at place-time and copy
   the resolved `amountMinor` + `currency` onto the order; never hold a live
   reference back into the `price` table.
2. **Freeze the header currency.** Take the single order currency from those
   resolved prices and treat it as immutable for the order's lifetime — the
   tombstone of the multi-currency decision made at checkout.

## 4. Why record this now

The cheapest place to get currency immutability right is *before* the order
capability is written, because the constraint is structural, not cosmetic.
Modelling currency as part of price identity (rather than a display attribute)
already pushes every consumer toward "currency is a required dimension of an
amount." Writing that expectation down here means the order side starts from
"capture and freeze" instead of discovering, after the fact, that orders quietly
re-price themselves or that two currencies have leaked into one total. The
groundwork — the scope, the resolution, the single-currency-per-read shape — is
laid; this note is the bridge to the side that will consume it.
