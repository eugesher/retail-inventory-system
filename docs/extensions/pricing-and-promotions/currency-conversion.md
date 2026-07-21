---
title: Currency conversion
cluster: Pricing & Promotions
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/pricing/domain/price.model.ts
  - apps/retail-microservice/src/modules/orders/domain/order.model.ts
---

# Currency conversion

## Description

**Currency conversion** lets a shop sell the same catalogue in more than one currency: a EUR customer sees
EUR prices, pays in EUR, and is invoiced in EUR, while a USD customer sees USD. There are two honest ways to
do it — **hold a real price per currency** (a maintained EUR price alongside the USD one) or **convert at
display from a base currency using an FX rate** — and mature platforms offer both: Shopify Markets holds
per-market prices, commercetools holds embedded prices per currency, and simpler shops convert on the fly.

The rail this guide must not break, and the one it is most tempted to: **no currency is ever converted
silently, and no currency default is ever a literal.** `Order.currency` is immutable, and the system reads
its default from **one** `DEFAULT_CURRENCY` env var through **three** deliberately separate DI tokens
(`CATALOG_DEFAULT_CURRENCY`, `RETAIL_DEFAULT_CURRENCY`, `CATALOG_GATEWAY_DEFAULT_CURRENCY`) — because a
catalog quoting one currency, a cart opening in another, and a price read scoped to a third would each be
wrong in a different direction. A silent conversion bakes the wrong unit into an immutable order forever, so
FX is always an **explicit step**, never an implicit one.

## Business needs

- **Cross-border selling** — the moment a shop ships to customers in another currency zone, showing and
  charging in the buyer's currency is a conversion-rate and trust necessity.
- **Price integrity per market** — a rounded, psychologically-priced EUR figure (€9,99) is not `USD 9.99 ×
  rate`; markets expect *maintained* local prices, not raw conversions, for the prices that matter.
- **Correct settlement and accounting** — the currency a customer paid in is part of the immutable contract;
  it must be captured exactly and never retro-converted when rates move.
- The threshold: a single-currency shop needs none of this; the first customer who must see and pay in a
  currency other than the shop's default is where currency has to become a real axis rather than a fixed
  default.

## Attachment points in the current core

- **The `Price` ledger's per-currency scope at
  `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts`.** Currency is **already** half the
  ledger's scope key: a `Price` is scoped by `(variantId, currency)`, and the at-most-one-open-row
  invariant and its `open_scope_key` backstop are defined *per currency* (ADR-026 §2–3). So holding a real
  EUR price alongside a USD price is **already expressible** — a EUR open row and a USD open row are
  distinct scopes that coexist without colliding. Multi-currency *pricing* needs no new scope; it needs the
  rows populated and a resolution that picks the buyer's currency.
- **`Order.currency` — immutable, validated, frozen at placement** (`order.model.ts`). It is a `readonly`
  three-letter code, checked against `^[A-Z]{3}$` in the constructor. Whatever currency the order is placed
  in is the currency it keeps forever; conversion cannot happen after placement, only before.
- **The three currency-default tokens** (`CATALOG_DEFAULT_CURRENCY`, `RETAIL_DEFAULT_CURRENCY`,
  `CATALOG_GATEWAY_DEFAULT_CURRENCY`), all reading the one `DEFAULT_CURRENCY` Joi var (default `USD`,
  `length(3).uppercase()`). A multi-currency capability makes the *resolution* of "which currency for this
  request" richer, but it must keep flowing through these tokens — it must not introduce a hard-coded
  fallback currency anywhere.

## Implementation sketch

- **Prefer maintained per-currency prices; convert only as a fallback.** Because `(variantId, currency)` is
  already the ledger scope, a real EUR price is a first-class row set through the existing `catalog.price.set`
  path — no model change. The multi-currency work is (a) resolving the buyer's currency for a request and
  (b) selecting the price row for that currency. Where a maintained row is absent, an **explicit** FX
  conversion from a base currency fills in — displayed as approximate, and *resolved to a concrete figure at
  cart/placement*, never left as a live rate on an order.
- **An `FX_RATE` port for the conversion path.** A `convert(amountMinor, from, to, asOf)` seam, adapter-bound
  to a rate provider, transport-free and unit-testable like the other pricing ports. The rate used is
  captured with the resulting price so the conversion is reconstructable — the same capture-not-recompute
  discipline the tax and price snapshots use.
- **Currency is resolved once, early, and carried.** The buyer's currency is resolved at cart open (the cart
  already opens in a currency) and the order inherits it immutably at placement. Every downstream money
  figure — line prices, tax, discounts — is in that one currency; there is no mixed-currency order.
- **Rounding is per-currency and explicit.** Minor units differ (JPY has none, most have two); a conversion
  rounds to the target currency's minor unit as a defined step, not an incidental float artefact.
- **Events ride `ris.events`** — no new transport; a per-currency price change is the existing
  `catalog.price.changed` carrying its currency scope. **No PII** (ADR-037).
- **Shared types** (the FX rate, the multi-currency price view) under `libs/contracts/<cluster>/`; a cached
  per-currency price read uses the existing `CACHE_KEYS.catalogPrice(variantId, currency)` builder, which
  **already keys on currency** — never a literal.

## Open design questions

- **Maintained prices vs. live conversion, per market.** Maintained rows give price integrity but must be
  managed for every variant × currency; live conversion is zero-maintenance but yields un-rounded,
  rate-drifting figures. Most shops want maintained rows for key markets and conversion for the long tail —
  the boundary is a per-market call.
- **When the rate is locked** — at display, at add-to-cart, or at placement. A rate that moves between
  showing a price and charging it is a customer-trust and margin problem; the lock point trades freshness
  against surprise.
- **Multi-currency balances and refunds** — a refund must return the *currency the customer paid in*, at the
  captured amount, not a re-converted figure; this constrains how store credit and gift cards (single-currency
  by the ledger rule) interact with a multi-currency catalogue.
- **Which token resolves a guest's currency** — geolocation, an explicit selector, or the accept-language
  header. Whatever the input, it must resolve *through* the existing default tokens, not around them.
- **Rounding and psychological pricing** — whether converted prices are re-rounded to local price points
  (€9,99 not €9,17) is a merchandising decision the conversion path has to accommodate.

## Effort sketch

`2–3 capabilities` — currency resolution per request, per-currency price selection over the ledger scope
that already exists, and the explicit `FX_RATE` conversion-and-capture fallback. It is bounded **because**
currency is already the ledger's scope axis and `Order.currency` already immutable; the work is resolution,
an FX port, and the discipline that keeps every conversion explicit and every default flowing through the
three tokens — never a literal.
