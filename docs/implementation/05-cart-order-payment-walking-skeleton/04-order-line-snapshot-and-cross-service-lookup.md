# 04 — Order-line snapshots and the cross-service catalog lookup

Placing an order turns a mutable cart into an **immutable** order. The single most
important property of that conversion is that **the order is a frozen snapshot of
what was bought and at what price** — a later catalog rename or price change must
never rewrite a placed order. This document explains how Place Order fetches the
variant metadata and the applicable price from the catalog at write-time and freezes
them onto each `OrderLine`, why the snapshot — not the live catalog row — is the
contract with the buyer, and the cross-service ports that make the lookup possible.

## What gets snapshotted, and from where

Each cart line carries only an opaque `variantId` and a `quantity` (the cart already
snapshotted its own working price, but Place Order re-resolves the authoritative
price at placement). For every cart line, Place Order reads two things from the
catalog microservice and freezes them onto the new `OrderLine`:

| `OrderLine` field   | Source                                                      |
| ------------------- | ----------------------------------------------------------- |
| `sku`               | `catalog.variant.get` → the variant's SKU                   |
| `nameSnapshot`      | `catalog.variant.get` → product name + variant option values |
| `unitPriceMinor`    | `catalog.price.select` → the applicable price's `amountMinor` |
| `taxAmountMinor`    | `0` (no tax capability — see below)                         |
| `discountAmountMinor` | `0` (no discount capability)                              |
| `lineTotalMinor`    | derived: `unitPriceMinor × quantity`                        |

`nameSnapshot` is **composed**: the product name plus the variant's option values,
e.g. `Aurora Desk Lamp (color: warm-white)`. Composing the option values (sorted for
a deterministic string) gives a richer, storefront-faithful label than the bare
product name, so a placed line reads the way the shopper saw it. A variant with no
option values snapshots the plain product name.

The variant is the **backbone key** the whole platform addresses
([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)) — inventory
stock, pricing, and order/cart lines all key on `variantId`. The retail domain never
imports the catalog `ProductVariant`; the only coupling is this read over the wire
plus the FK in persistence.

## Why the snapshot is the contract, not the live row

An order is an audit record: an invoice, a fulfillment instruction, a thing a
customer can dispute. If the order line referenced the live catalog row, then
re-pricing a product tomorrow, or renaming it, or archiving the variant, would
silently rewrite every historical order that contained it. That is wrong — the buyer
agreed to a specific price for a specifically named item at a specific instant.

So the line **freezes** the catalog values at place-time. `OrderLine` is fully
immutable — every field is `readonly` and the instance is `Object.freeze`-d at
construction — so the snapshot cannot drift after placement
([ADR-028 §1](../../adr/028-cart-order-payment-and-address-chain.md)). A later price
change appends a new `price` row (the pricing ledger never mutates history,
[ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md)); a later
rename updates the catalog `product` row; neither touches the placed `order_line`.
The variant stays resolvable even after it is archived precisely so that the
historical reference never dangles
([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)).

## The cross-service ports

The lookup is mediated by a port so the use case stays transport-free
([ADR-009](../../adr/009-port-adapter-at-the-gateway.md)):

- **`IOrderCatalogGatewayPort`** (`ORDER_CATALOG_GATEWAY`) exposes
  `getVariant(variantId)` and `selectApplicablePrice(variantId, currency)`.
- Its adapter, `OrderCatalogRabbitmqAdapter`, is the only `ClientProxy` holder for
  the read path; it sends `catalog.variant.get` and `catalog.price.select` through
  the `CATALOG_MICROSERVICE` client onto `catalog_queue`, where the catalog and
  pricing controllers serve them.

Both reads run **outside** the database transaction (they are out-of-process RPCs);
only the subsequent persistence runs transactionally.

## The "no applicable price → reject" rule

`catalog.price.select` resolves the single applicable price for a
`(variantId, currency)` scope as of now, or `null` when none is in effect. A `null`
means the variant cannot be priced in the cart's currency at place-time, so Place
Order **rejects the whole placement** with a typed `ORDER_LINE_NO_PRICE` error,
mapped to HTTP `409` at the gateway. Snapshotting a zero-price line would silently
sell the item for nothing; refusing the placement surfaces the misconfiguration
instead. (The cart's Add-to-Cart step applies the same rule at add-time, but
re-checking at placement closes the window where a price was withdrawn after the
item entered the cart.)

## Tax, discount, and shipping are zero here

This capability has no tax, discount, or shipping computation. The catalog's tax
category is a **classification label only** — it carries no rate
([ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md)) — so
`taxAmountMinor` and `discountAmountMinor` are `0` on every line and
`shippingTotalMinor` / `taxTotalMinor` / `discountTotalMinor` are `0` on the order.
The order's total invariant therefore reduces to
`grandTotalMinor = subtotalMinor = Σ line.lineTotalMinor`, asserted in the `Order`
constructor so a header total can never silently disagree with its lines. Real tax,
discount, and shipping are later capabilities; the money fields already exist on the
schema and domain so adding them is non-destructive.

## Related documents

- [03 — Order three-status model](03-order-three-status-and-q4-decision.md) — the
  immutable `Order` and its orthogonal status axes.
- [06 — Polymorphic address snapshot](06-address-polymorphic-snapshot.md) — the
  sibling "snapshot, not reference" decision for billing/shipping.
- [07 — Authorize on place, capture explicit](07-authorize-on-place-capture-explicit-q5.md)
  — the payment half of placement.
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md),
  [ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md),
  [ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md).
