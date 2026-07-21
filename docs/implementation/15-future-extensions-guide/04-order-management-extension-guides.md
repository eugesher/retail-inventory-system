# 04 — Order Management extension guides

The ten Order Management guides under [`docs/extensions/`](../../extensions/) sketch how a business would
grow the checkout past the universal core. This is the heaviest cluster and the one where money moves, so
the discipline is not "invent a design" but "add a capability without losing money in a hypothetical
future". It is also the cluster with the most downstream dependents: **five** of the ten own a shared
premise that later clusters build on. Every path, field, port, routing key and status transition named
below was read out of the source this session, not from prior notes — the money path in this module has
been reworked more than once, and `docs/implementation/` describes the shape at ship time, not today.

## The ten guides

### [subscriptions-recurring-orders.md](../../extensions/order-management/subscriptions-recurring-orders.md)

- **Claim.** The recurrence engine — a scheduler that generates a new `Order` per cycle, resolves price
  at charge time, and runs the dunning ladder. Links [subscriptions-and-selling-plans.md](../../extensions/product-catalog/subscriptions-and-selling-plans.md)
  and quotes its plan/engine boundary.
- **Attaches to.** `Order` and the orders scheduling infrastructure at
  [`infrastructure/scheduling/`](../../../apps/retail-microservice/src/modules/orders/infrastructure/scheduling/).
- **Hardest to reverse.** Whether a subscription *instance* is a new aggregate or order metadata. Modelled
  as a mutable `Subscription` aggregate that produces orders; unwinding that later is a data migration.

### [gift-cards-and-store-credit.md](../../extensions/order-management/gift-cards-and-store-credit.md)

- **Claim.** A tender that is not a card. **Owns the store-credit ledger** and the "opaque
  `Payment.method`" argument.
- **Attaches to.** `Payment` and `Refund`.
- **Hardest to reverse.** That the balance is an **append-only ledger with a derived sum**, not a mutable
  number. This is the shape the returns cluster's refund-to-store-credit inherits; changing it after the
  fact rewrites every balance.

### [dropshipping-vendor-routing.md](../../extensions/order-management/dropshipping-vendor-routing.md)

- **Claim.** Route a `Fulfillment` to a vendor who ships directly, via a vendor-backed virtual location.
  Links [supplier-and-vendor.md](../../extensions/product-catalog/supplier-and-vendor.md).
- **Attaches to.** `Fulfillment` and `FulfillmentLine`.
- **Hardest to reverse.** Whether dropship stock participates in availability at all — a "vendor has
  infinite stock" assumption removes no-oversell for those lines and is hard to retrofit a stock feed onto.

### [marketplace-seller-payouts.md](../../extensions/order-management/marketplace-seller-payouts.md)

- **Claim.** One buyer capture fans out into per-seller payouts minus commission. Links
  [supplier-and-vendor.md](../../extensions/product-catalog/supplier-and-vendor.md) (the seller *is* the supplier party).
- **Attaches to.** `Payment` and `Refund`.
- **Hardest to reverse.** Split capture vs. split settlement — whether the buyer's money is captured once
  and redistributed, or captured directly to each seller. The first keeps `Payment` a single row; the
  second needs a split-payment gateway. Everything downstream hangs off that choice.

### [b2b-quote-po-credit-terms.md](../../extensions/order-management/b2b-quote-po-credit-terms.md)

- **Claim.** A negotiable `Quote` (a mutable pre-order), a `BusinessAccount` party, and net-terms payment.
  **Owns the B2B account/quote/credit-terms model.**
- **Attaches to.** `Order` (the quote's different immutability story) and `Payment` (capture not at ship).
- **Hardest to reverse.** How immutable an accepted quote is before it converts — quoted price vs. live
  price at conversion. It fixes the negotiation's meaning and the whole B2B pricing story built on it.

### [fraud-and-risk-scoring.md](../../extensions/order-management/fraud-and-risk-scoring.md)

- **Claim.** A score requested at place-time that can allow, hold or block. **Owns the risk-scoring seam**,
  and states that scoring is external.
- **Attaches to.**
  [`place-order.use-case.ts`](../../../apps/retail-microservice/src/modules/orders/application/use-cases/place-order.use-case.ts)
  and the `PAYMENT_GATEWAY` port (the external-provider-port precedent).
- **Hardest to reverse.** Synchronous block vs. asynchronous review, and fail-open vs. fail-closed on a
  provider outage — latency and risk trade-offs baked into the place path.

### [tax-computation-engine.md](../../extensions/order-management/tax-computation-engine.md)

- **Claim.** An external engine called at place-time, writing the captured-not-computed `taxAmountMinor`.
  **Owns the tax call-out seam.** Points at the [`Not built yet` tax gap](../../../README.md#14-not-built-yet).
- **Attaches to.** `OrderLine` (the `taxAmountMinor` seam) and
  [`tax-category.model.ts`](../../../apps/catalog-microservice/src/modules/pricing/domain/tax-category.model.ts)
  (the label the engine keys on).
- **Hardest to reverse.** Estimate-at-cart vs. commit-at-place, and tax-inclusive vs. tax-exclusive
  pricing — the second decides whether the engine adds or subtracts from the ledger price.

### [shipping-rate-engine.md](../../extensions/order-management/shipping-rate-engine.md)

- **Claim.** Rate the destination `Address` at checkout, writing the waiting `shippingTotalMinor` seam.
- **Attaches to.** `Fulfillment` (the shipment origin) and `Address` (the destination).
- **Hardest to reverse.** Where shippable weight/dimensions live — the catalog has no weight attribute
  today, so rating depends on a catalog extension it cannot supply itself.

### [bnpl-state-machines.md](../../extensions/order-management/bnpl-state-machines.md)

- **Claim.** An installment tender whose async confirmation reuses ADR-052's capture claim. Links
  [gift-cards-and-store-credit.md](../../extensions/order-management/gift-cards-and-store-credit.md) for the non-card-tender
  argument.
- **Attaches to.** `Payment` (the `CAPTURING` state) and the `PAYMENT_GATEWAY` port.
- **Hardest to reverse.** Webhook trust and idempotency — a provider webhook is an untrusted at-least-once
  inbound, and making its handler non-double-settling is the core correctness problem.

### [replacement-orders-distinct-entity.md](../../extensions/order-management/replacement-orders-distinct-entity.md)

- **Claim.** A replacement is a new, zero-value `Order` linked to the original. **Owns the
  replacement-as-a-new-`Order` argument.**
- **Attaches to.** `Order` and
  [`return-request.model.ts`](../../../apps/retail-microservice/src/modules/returns/domain/return-request.model.ts).
- **Hardest to reverse.** What zero-values the order — 0-priced lines vs. a 100% order discount. That
  choice is inherited by the returns cluster's exchange and advance-replacement guides.

## The five shared premises this cluster owns

Five of the ten guides settle a decision a later session builds on. Each is stated concretely in the guide
and repeated in `carryover-04.md` so a downstream author quotes it rather than re-opening it.

| Owner | The decision, settled | Downstream inherits |
| --- | --- | --- |
| gift-cards-and-store-credit | Store credit is an **append-only ledger** (`price`/`stock_movement` precedent); the **balance is a derived sum**, never stored. Single-currency per account, fixed at issuance — no silent FX, because `Order.currency` is immutable. Redemption is a `Payment` with an opaque `method`. | refund-to-store-credit (Returns): a refund whose destination is this ledger. |
| b2b-quote-po-credit-terms | A `BusinessAccount` party; a `Quote` that is a **mutable pre-order** (`draft → sent → accepted → converted`) becoming an immutable `Order` on acceptance; net-terms capture **decoupled from ship** (the payment axis stays uncaptured while fulfilment advances). | b2b-company-hierarchies (Customer & Identity): a tree of accounts. b2b-contract-pricing (Pricing): account-scoped price rules. |
| fraud-and-risk-scoring | A `RISK_SCORING_GATEWAY` **external port** (the `PAYMENT_GATEWAY` precedent), called at **place-time**, returning a **three-way verdict** (allow / hold / block). No PII crosses the bus; the provider gets identity directly from the adapter. | return-fraud-scoring (Returns): the same seam and verb set against return requests. |
| tax-computation-engine | A `TAX_ENGINE` **external port** called at **place-time**, writing the **captured-not-computed** `taxAmountMinor` (which already exists, defaults 0). Store the amount + the engine's opaque calc reference; never recompute a placed order. The `TaxCategory` label is the engine's key, not a rate. | tax-rate-tables (Pricing): an *internal* adapter for the same port, reading the same label. |
| replacement-orders-distinct-entity | A replacement is a **new `Order`** linked by `replacesOrderId`, reusing lines/fulfilment/allocation, with a **zero-value money path** (place skips authorize when the grand total is 0). The original is never mutated. | exchanges-as-first-class-entity and advance-replacement (Returns): both compose "replacement = new order". |

One more pairing worth recording: **gift-cards owns "a tender that is not a card"**, and **bnpl links it**.
Both touch `Payment`; store credit is the more foundational internal-tender concept (it owns the ledger
anyway), so it makes the opaque-`method` argument, and BNPL — an external installment tender — composes it
and adds only the async settlement machine.

## The money rails an order extension inherits

Seven of the ten guides touch at least one of these. They are stated once here rather than in every guide,
and every sketch above was checked against all five.

1. **Request-level idempotency on the money-/stock-moving writes**
   ([ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md)). Any new mutating operation a
   sketch proposes says whether it joins that set and what its key is — subscription cycles key on
   `(subscriptionId, cycleNumber)`, payouts on `(sellerId, payoutPeriod)`, credit redemption on the
   checkout key. A new operation that moves money without an idempotency key is a double-charge waiting for
   a retry.

2. **One OCC retry protocol** ([ADR-045](../../adr/045-one-occ-retry-protocol.md)). Every aggregate write
   is version-checked and bounded by `OCC_RETRY_ATTEMPTS` through `runWithOccRetry`; no sketch invents a
   second retry ladder. The store-credit ledger leans on this for "two redemptions cannot both spend the
   last unit" — no-oversell, applied to money.

3. **`Order.currency` is immutable, and no currency default is ever a literal.** Three DI tokens —
   `RETAIL_DEFAULT_CURRENCY`, `CATALOG_DEFAULT_CURRENCY`, `CATALOG_GATEWAY_DEFAULT_CURRENCY` — read one
   `DEFAULT_CURRENCY` var deliberately. Every currency-touching sketch (store credit, payouts, multi-seller)
   treats a stored amount's currency as fixed forever; cross-currency is an **explicit** FX step, never an
   implicit reinterpretation. A multi-currency sketch that ignores this is proposing a bug.

4. **`order_line.quantity` never shrinks; the units still owed are `activeQuantity`**
   (`quantity − cancelledQuantity`, [ADR-040](../../adr/040-persisted-cancelled-quantity-on-order-line.md)).
   Any sketch reasoning about "remaining units" — a re-route, a partial replacement, a partial refund —
   measures against `activeQuantity`, read out of `order-line.model.ts`, not the place-time `quantity`.

5. **The capture claim** ([ADR-052](../../adr/052-claim-before-you-charge.md)). `Payment.beginCapture()`
   walks `AUTHORIZED → CAPTURING` and **commits before the gateway is called**, under a `SELECT … FOR
   UPDATE`. It is a general async-settlement primitive, not just a double-capture guard — BNPL's
   webhook-confirmed settlement and the subscription dunning retry both ride it rather than inventing
   mutual exclusion. The stale-claim sweeper only *surfaces* `CAPTURING` rows; it never resolves a claim it
   cannot prove landed.

And the sixth rail, cross-cutting all: **no PII in an event payload or an audit row**
([ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md)). The fraud, payout and BNPL sketches all
need a provider to see buyer identity — and all route that identity **directly from the adapter to the
provider**, never through `ris.events`. A score request or payout event that ships an email over the bus is
wrong, not convenient.
