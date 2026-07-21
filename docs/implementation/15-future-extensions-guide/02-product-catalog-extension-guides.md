# Product Catalog extension guides

This note records the nine [Product Catalog extension guides](../../extensions/README.md) — the
sketches under [`docs/extensions/`](../../extensions/) describing how a catalog capability outside the
universal core would attach if a business ever needed it. The folder's rules, template and structure
check are covered by its [sibling note](01-extension-guide-structure-and-template.md) and by
[ADR-055](../../adr/055-where-deliberately-unbuilt-work-is-recorded.md); this note explains the nine
guides themselves — what each claims, which seam of the catalog it attaches to, and the one design
call that would be hardest to reverse once built.

Two of the nine own a premise that several later guides depend on, so their shape is load-bearing
rather than local. Those two get their own cross-cutting sections at the end.

Every path, aggregate, token and routing key named in the guides was read out of the source, not
copied from a document — the folder's own rule, and the reason the guides can be trusted where the
structure check cannot reach (it verifies attachment *paths* on disk, never the prose).

## The nine guides

### Product bundles and kits

Claims a bundle — a kit sold as one unit, or a dynamic set priced together — belongs on the catalog
side as a `bundle_component` relationship over the `variantId` backbone, with availability composed
from component stock rather than stored as a second running total. Attaches to the `Product` /
`ProductVariant` aggregates, the cart's `CartLine` (whose add-time price snapshot is why bundle
pricing is not the sum of parts), and the inventory stock module. **Hardest to reverse:** *when* a
bundle explodes into component lines — at add-to-cart, at place-order, or never. That choice
propagates into reservation, refund and order-display logic, and unwinding it later touches every
buying path.

### Dynamic typed attribute schemas

Claims the untyped `optionValues: Record<string, string>` map on `ProductVariant` should be replaced
or wrapped by typed, per-category `AttributeDefinition`s, validated through a use-case probe (the same
shape as the publish-time price check the domain deliberately does not model). Attaches to the
`Product` / `ProductVariant` models and the view classes under
[`libs/contracts/catalog/`](../../../libs/contracts/catalog). **Hardest to reverse:** EAV versus a
JSON column for attribute storage — the two facet-search and validate so differently that switching
after data exists is a migration of every product, and the contract-view rewrite it forces touches
every catalog consumer.

### Configurable products and option dependencies

Claims cross-option rules ("16GB only with the discrete GPU") sit above the flat variant axis, and the
whole design turns on one fork: pre-generate a `ProductVariant` for every legal combination (reusing
the entire existing stock/price/cart stack keyed on the concrete `variantId`) versus keep options and
evaluate dependency rules at selection time. Attaches to the variant axis and the cart add path.
**Hardest to reverse:** that pre-generate-versus-runtime fork — it decides which service owns the rule
model and whether the variant table is combinatorial.

### Digital goods and entitlements

Claims a non-physical variant needs a *kind* flag and a shipment-less fulfilment path, because the
core's `Fulfillment` requires a `stockLocationId` and captures payment on ship. The entitlement
reaches the customer through the existing notification render pipeline. Attaches to `ProductVariant`,
the `Fulfillment` aggregate, and the notification module. **Hardest to reverse:** whether an
entitlement is a `Fulfillment` subtype or its own aggregate — the choice forks the order's fulfilment
roll-up and the refund-time revocation path, neither of which has a physical-goods analogue.

### Subscriptions and selling plans

Owns the plan definition (see the cross-cutting section below). Attaches to `ProductVariant` and the
`price` ledger. **Hardest to reverse:** whether the plan stores a percentage discount off the resolved
active price or a plan-scoped `Price` ledger row that wins on `priority` — the second is more
expressive ("£9 for the first three boxes") but multiplies ledger rows permanently.

### Product relations and recommendations

Claims the *curated* product-to-product graph (related / cross-sell / up-sell / accessory) is a
catalog self-join that adopts the reserved `catalogProduct*` cache builders with no re-keying, while
*computed* behavioural recommendations are explicitly a downstream read/analytics concern, not a
catalog extension. Attaches to the `Product` aggregate and
[`libs/cache/cache-keys.ts`](../../../libs/cache/cache-keys.ts). **Hardest to reverse:** whether
relations key on products or variants — "buy the matching strap" is variant-specific, and the choice
ripples into every read.

### Brand as a first-class entity

Claims a brand is an orthogonal facet — a small `Brand` aggregate with a nullable `brandId` on
`Product` — and specifically *not* a node in the category tree, because a brand cuts across the
hierarchy and would corrupt the tree's "one product, one path" meaning. The logo reuses the
polymorphic `MediaAsset` by adding a `brand` member to `MediaOwnerTypeEnum`. Attaches to `Category`
(the tree it must stay out of) and `MediaAsset`. **Hardest to reverse:** own aggregate versus a
category subtype — the guide argues for the aggregate, and retrofitting one after brands were faked as
categories means untangling every mis-parented product.

### Supplier and vendor

Owns the Supplier / Vendor party (see the cross-cutting section below). Attaches to `ProductVariant`
(the `variantId` a supply relationship rides) and `StockMovement` (whose FK-less polymorphic
`referenceType` / `referenceId` already lets a goods receipt point at a purchase order). **Hardest to
reverse:** placing it in a new Procurement service rather than a column on the variant — but that is
the decision four later guides inherit, so it is meant to be settled once here.

### Multi-locale translation tables

Claims per-locale translation rows for `Product` / `Category` strings, resolved down a fallback chain,
and notes the locale seam already exists downstream — every notification producer ships
`customerLocale: null` today, and the `notificationsTemplate` cache builder already keys on `locale`.
Attaches to the `Product` / `Category` models, the notification module, and
[`libs/cache/cache-keys.ts`](../../../libs/cache/cache-keys.ts). **Hardest to reverse:** sidecar
translation tables versus a JSON-per-field map — the two index and fall back so differently that
switching is a full re-translation migration.

## Why `Supplier` is not a catalog entity

The register places the Supplier / Vendor party in a **Procurement bounded context**, and the
[supplier and vendor](../../extensions/product-catalog/supplier-and-vendor.md) guide makes that concrete: a new
deployable, `apps/procurement-microservice/`, not a `supplier` column hung off `product_variant`.

The reasoning is weight class. A party that owns purchase orders, goods-receipt records and payment
terms is a bounded context with its own aggregates and lifecycle. Under
[ADR-018](../../adr/018-nestjs-monorepo-apps-and-libs.md) a new service is `apps/<name>/`, and under
[ADR-042](../../adr/042-one-bounded-context-one-module.md) that one context is one module — a
per-module hexagon whose Nest module file is its composition root
([ADR-041](../../adr/041-nest-module-as-the-module-composition-root.md)). A column on the variant is
rejected precisely because it cannot grow the purchase-order and receipt aggregates the dependents
need. The link to sellable goods is a `SupplyItem` relationship keyed on `(supplierId, variantId)`,
treating `variantId` as an opaque link exactly as the `price` ledger does — procurement never imports
the catalog `ProductVariant`. It emits dotted `<service>.<aggregate>.<action>` events
(`procurement.supplier.registered`, `procurement.purchase-order.received`, …) on the existing
`ris.events` topic exchange.

Four later guides build directly on this and must not re-model it: consigned / vendor-managed
inventory, dropshipping vendor routing, marketplace seller payouts, and vendor RMAs. What they inherit
is fixed here — the party identity, the `variantId`-keyed supply relationship, and the event surface —
so those guides link back rather than redefining a supplier three different ways. A brand is
deliberately kept separate from a supplier: the [brand](../../extensions/product-catalog/brand-entity.md) guide owns
the marketing identity on the product, this one owns the party the goods were bought from, and one
variant can carry one brand while being sourced from several suppliers.

## Where the subscription boundary falls

The subscription story splits across two guides, and the line between them is drawn here so it does
not have to be renegotiated later.

**Plan definition — the catalog side, owned by
[subscriptions and selling plans](../../extensions/product-catalog/subscriptions-and-selling-plans.md).** A
`SellingPlan` says which variants are subscribable, on which cadences, and how the recurring price
relates to the one-off `price` ledger row for the same variant. It references `variantId` opaquely and
states a *relationship* to the ledger — a discount off the resolved active price, or a plan-scoped row
that wins on `priority` — never an in-place edit of the one-off row, so `Price` stays the single
source of the number.

**Recurrence engine — the order-management side, owned by a later guide.** The scheduled `Order`
generation, the payment retry ladder, dunning, and pause / skip are order concerns driven by a clock.
The engine resolves the active price from the ledger at each charge and applies the plan's adjustment.

Splitting it this way keeps the catalog free of scheduling: the catalog never runs a clock, and a
subscription *instance* is order data, not product data. A plan is a durable offer attached to a
variant; a subscription is a recurring series of orders. Keeping the definition in the catalog and the
engine in order management means each side owns exactly the state it can enforce — the catalog owns
what can be subscribed to, order management owns what has been charged — and neither has to reach into
the other's aggregates.
