# Retail Inventory System — Minimum Entity & Functionality Research

## Executive Summary

The universal core of a retail inventory backend resolves to **28 entities across 8 domain clusters** and **roughly 55 universally-required operations**. The model is e-commerce-first, but two physical-retail concessions are unavoidable in the universal core: a `StockLocation` entity (without it, multi-warehouse and store-fulfilled e-commerce both break) and an explicit `Reservation` concept (without it, oversell-under-concurrency is a guaranteed bug). The dominant architectural observation is that **Inventory is the most consistency-sensitive cluster**, while **Order Management is the most state-machine-heavy**; everything else is essentially CRUD with audit. The model deliberately externalizes payment capture, tax computation, shipping rating, and loyalty — these are not retail-universal, they are pluggable concerns retail businesses customize per vertical. The reference models converge tightly on Product/Variant/SKU, Order/OrderLine, and StockLocation/StockLevel; they diverge sharply on whether "Reservation" is an entity (Saleor's `Stock.quantityReserved: Int!` field is described as "Quantity reserved for checkouts"; Medusa's `ReservationItem` data model "represents unavailable quantity of an inventory item in a location" and is created per inventory item on order placement; Vendure has no `Reservation` subtype — `StockMovement` is an abstract class with concrete subclasses `Allocation`, `Cancellation`, `Release`, `Sale`, `StockAdjustment`, and an `Allocation` is created on checkout completion to prevent overselling). We side with explicit reservation.

## Domain Clusters

For each cluster: **Entities → Operations → Boundary analysis** in that order. Entity attributes are listed only where universality is non-obvious.

---

### 1. Product Catalog

**Entities**

- **Product** (PascalCase, singular). Purpose: the merchandisable abstract good a customer recognizes (e.g., "Acme T-Shirt"). Attributes: `id`, `name`, `slug`, `description`, `status` (draft/active/archived), `createdAt`. Relationships: 1→N `ProductVariant`, N↔M `Category`. Actors: both (Customer reads; User authors). Universality: every retail business sells _something_; the product/variant split is canonical across commercetools, Shopify, Saleor, Vendure, Medusa, and the NRF ARTS ODM.
- **ProductVariant**. Purpose: the actually-sellable, stocked, priced unit (color/size combination, or the only variant when a product has no options). Attributes: `id`, `sku` (unique), `gtin` (optional, GS1-compliant when present), `productId`, `optionValues`, `weight`, `dimensions`, `status`. Relationships: N→1 `Product`, 1→N `StockLevel`, 1→N `Price`. Actors: both. Universality: stock, pricing, and inventory operations attach to the variant, not the product — this is invariant across all reference platforms.
- **Category**. Purpose: hierarchical merchandising classification consumers browse by. Attributes: `id`, `name`, `slug`, `parentId` (self-referential), `path`. Relationships: self-hierarchical, N↔M `Product`. Actors: both. Universality: any catalog above ~20 SKUs requires browsing; flat-tag-only catalogs are a niche extension.
- **MediaAsset**. Purpose: image/video/document attached to product or variant. Attributes: `id`, `uri`, `type`, `altText`, `sortOrder`, `ownerId`, `ownerType`. Relationships: N→1 polymorphic to `Product` or `ProductVariant`. Actors: both. Universality: image-less e-commerce does not exist; including it in core avoids every downstream system reinventing a media association table.

**Operations**

- **Register Product** (User). Trigger: staff creates a product draft. Preconditions: caller has `catalog:write`. Outcome: new Product in `draft` state; no variants yet. Cross-domain: none until activation.
- **Add Variant** (User). Trigger: staff adds a variant to a product. Preconditions: parent Product exists; `sku` globally unique. Outcome: ProductVariant persisted; emits `VariantCreated`. Cross-domain: Inventory cluster MAY auto-initialize `StockLevel = 0` at the default location (recommended).
- **Publish Product** (User). Trigger: status transition draft→active. Preconditions: ≥1 variant; ≥1 active `Price` for the variant; ≥1 `MediaAsset` (recommended, not strict). Outcome: Product becomes Customer-visible. Cross-domain: emits `ProductPublished` consumed by search-indexing and storefront caches.
- **Archive Product** (User). Trigger: discontinuation. Preconditions: no open orders referencing only this product's variants (advisory). Outcome: status→archived; product hidden from Customer browse but referenceable from historical Orders.
- **Reclassify Product** (User). Trigger: attach/detach Category. Outcome: catalog navigation reshapes.
- **Query Catalog** (Customer). Trigger: browse/search. Preconditions: none. Outcome: read-only projection; emits no events.

**Boundary analysis**

- _Minimal slice:_ Product + ProductVariant + Price (the latter living in the Pricing cluster). Category and MediaAsset can be deferred for a true MVP, though every commerce platform ships them in v1.
- _First natural extension point:_ per-attribute typed Product Types (commercetools' AttributeDefinition, Saleor's Attribute, Shopify's metafields) — i.e., schema-on-data for vertical-specific fields like ISBN for books or wattage for appliances. This belongs OUTSIDE the universal core.
- _What depends on this cluster:_ Inventory (StockLevel keys on Variant), Pricing (Price keys on Variant), Order Management (OrderLine snapshots Variant), Returns (RMA lines reference Variant). Nothing in the core works without Product Catalog.

**Exclusions from universal core:** Product bundles/kits, dynamic attribute schemas, configurable products with rule-based option dependencies, digital-good entitlements, subscription/selling plans, product recommendations/relations, multi-language localization tables (use a translation extension), brand entity (often modeled as a Category or vendor-specific extension), supplier/vendor entity (belongs in a separate Procurement bounded context).

---

### 2. Inventory

**Entities**

- **StockLocation**. Purpose: a physical or logical place where stock physically resides. Attributes: `id`, `name`, `code`, `type` (warehouse | store | dropship-virtual), `address`, `gln` (GS1 Global Location Number, optional), `active`. Relationships: 1→N `StockLevel`, 1→N `StockMovement`. Actors: User. Universality: even single-location merchants have one — per Vendure's Stock Control documentation, "If you do not have multiple stock locations, then you can simply use the default location which is created automatically." Saleor and Medusa similarly model it as a required core entity. Omitting it forces every downstream model to assume a single implicit location, which breaks the moment a business opens a second warehouse or enables ship-from-store.
- **StockLevel**. Purpose: the on-hand and allocated quantities of one variant at one location. Attributes: `id`, `variantId`, `stockLocationId`, `quantityOnHand`, `quantityAllocated`, `quantityReserved`, `version` (for optimistic concurrency). Relationships: N→1 `ProductVariant`, N→1 `StockLocation`. Actors: User (writes adjustments), Customer (reads availability indirectly). Universality: the join entity is unavoidable in any multi-location model and is harmless (one row) in single-location.
- **StockMovement**. Purpose: immutable ledger entry recording any change to StockLevel — receipts, adjustments, allocations, sales, cancellations, releases. Attributes: `id`, `stockLevelId`, `type` (receipt | adjustment | allocation | sale | release | return), `quantity` (signed), `reasonCode`, `referenceType`, `referenceId` (e.g., OrderLine id), `occurredAt`, `actorId`. Relationships: N→1 `StockLevel`, polymorphic reference to causing entity. Actors: User (manual), System (automatic). Universality: required for auditability, reconciliation, and event-sourced rebuilds. Per the Vendure TypeScript API reference, `StockMovement` is defined as `class StockMovement extends VendureEntity implements HasCustomFields` with five concrete subclasses (`Allocation`, `Cancellation`, `Release`, `Sale`, `StockAdjustment`) — the same ledger pattern appears in every mature OMS.
- **Reservation**. Purpose: a soft, time-bounded hold on stock for an in-progress checkout or cart, distinct from a firm Allocation that follows order placement. Attributes: `id`, `variantId`, `stockLocationId`, `quantity`, `cartId` (or sessionRef), `expiresAt`, `status` (active | committed | released | expired). Relationships: N→1 `ProductVariant`, N→1 `StockLocation`, N→1 `Cart`. Actors: System. Universality: Saleor's `Stock` GraphQL object exposes a `quantityReserved: Int!` field documented as "Quantity reserved for checkouts"; Medusa's `ReservationItem` data model "represents unavailable quantity of an inventory item in a location" and Medusa "creates a reservation item for each inventory item in the order" on placement; Vendure, by contrast, has no `Reservation` subtype — it relies on `Allocation`, which "is created for each ProductVariant in an Order when the checkout is completed (as configured by the StockAllocationStrategy)." We side with explicit Reservation because (a) it cleanly separates "cart-time soft hold" from "order-time firm hold," and (b) it makes expiry semantics auditable.

**Operations**

- **Receive Stock** (User). Trigger: warehouse intake. Preconditions: StockLocation active; Variant exists. Outcome: `quantityOnHand += n`; StockMovement of type `receipt` written. Cross-domain: Notifications MAY emit `LowStockResolved`.
- **Adjust Stock** (User). Trigger: cycle count, damage, shrinkage. Preconditions: `reasonCode` mandatory. Outcome: signed delta to `quantityOnHand`; StockMovement of type `adjustment`.
- **Reserve Stock** (System). Trigger: line added to active Cart (or checkout begins, depending on policy). Preconditions: `quantityOnHand − quantityAllocated − quantityReserved ≥ requested`. Outcome: new Reservation row; `quantityReserved += n`; emits `StockReserved`. Cross-domain: blocks oversell from concurrent carts.
- **Release Reservation** (System). Trigger: cart abandoned, reservation TTL expires, or line removed. Outcome: Reservation status→released/expired; `quantityReserved -= n`.
- **Allocate Stock** (System). Trigger: Order placed (Cart committed). Preconditions: matching active Reservation OR sufficient unreserved available. Outcome: Reservation→committed (or new Allocation StockMovement); `quantityAllocated += n`, `quantityReserved -= n`. Emits `StockAllocated`.
- **Commit Sale** (System). Trigger: Fulfillment shipped. Outcome: `quantityOnHand -= n`, `quantityAllocated -= n`; StockMovement of type `sale`. This is the physically-departing event.
- **Cancel Allocation** (System). Trigger: order or line cancelled before fulfillment. Outcome: `quantityAllocated -= n`; StockMovement of type `release`.
- **Restock from Return** (User). Trigger: returned item inspected as resellable. Outcome: `quantityOnHand += n`; StockMovement of type `return`.
- **Transfer Stock** (User). Trigger: inter-location move. Outcome: two StockMovements (negative at source, positive at destination); in-transit modeling is an extension.
- **Query Availability** (Customer/User). Trigger: storefront render or admin search. Outcome: read-only `available = quantityOnHand − quantityAllocated − quantityReserved`, optionally aggregated across locations.

**Boundary analysis**

- _Minimal slice:_ StockLocation (one row), StockLevel, and the ability to decrement on order placement. Reservation and StockMovement can be deferred for a single-user demo, but not for any production deployment where two carts may race for the last unit.
- _First natural extension point:_ multi-location order routing/sourcing logic (which location ships which line), demand forecasting, safety stock, lot/batch/serial tracking, expiry/FIFO. All vertical-specific.
- _What depends on this cluster:_ Order Management (cannot place an order without successful Reservation→Allocation), Returns (restock path), Notifications (low-stock alerts).

**Exclusions from universal core:** Lot/batch/serial number tracking (regulated industries only), expiry-date inventory rotation (perishables only), bin/aisle/shelf locations (WMS, not IMS), demand forecasting and replenishment rules, inter-location transfer orders as first-class workflow documents (basic transfer ops are in core; transfer-order documents are an extension), consigned/vendor-managed inventory, ABC classification, in-transit stock as a separate location.

---

### 3. Order Management

**Entities**

- **Cart**. Purpose: the pre-purchase, mutable container the Customer assembles before committing. Attributes: `id`, `customerId` (nullable for guest), `currency`, `status` (active | abandoned | converted), `createdAt`, `expiresAt`. Relationships: 1→N `CartLine`, N→1 `Customer` (optional). Actors: both. Universality: distinguishing Cart from Order is the cleanest way to separate mutable pre-purchase state from immutable post-purchase state, and every reference platform does so.
- **CartLine**. Purpose: a line item in a Cart. Attributes: `id`, `cartId`, `variantId`, `quantity`, `unitPriceSnapshot` (captured at add time, may refresh). Relationships: N→1 `Cart`, N→1 `ProductVariant`.
- **Order**. Purpose: the immutable record of a committed customer purchase. Attributes: `id`, `orderNumber` (human-facing, immutable), `customerId`, `status` (state machine — see Open Questions), `paymentStatus`, `fulfillmentStatus`, `currency`, `totals` (subtotal, tax, shipping, discount, grand), `billingAddress`, `shippingAddress`, `placedAt`, `version`. Relationships: 1→N `OrderLine`, 1→N `Fulfillment`, 1→N `Payment`, 1→N `ReturnRequest`. Actors: both. Universality: the central aggregate of any retail system.
- **OrderLine**. Purpose: an immutable line in an Order — snapshots product identity and price at time of placement. Attributes: `id`, `orderId`, `variantId`, `sku`, `nameSnapshot`, `quantity`, `unitPrice`, `taxAmount`, `discountAmount`, `lineTotal`, `status` (allocated | shipped | partially-shipped | cancelled | returned). Relationships: N→1 `Order`, references `ProductVariant`. Note: snapshotting is mandatory — product titles and prices change; orders must not.
- **Fulfillment**. Purpose: a shipment (or pickup batch) covering some subset of OrderLines from a single StockLocation. Attributes: `id`, `orderId`, `stockLocationId`, `status` (pending | shipped | delivered | cancelled), `trackingNumber`, `carrier`, `shippedAt`, `deliveredAt`. Relationships: N→1 `Order`, N→1 `StockLocation`, 1→N `FulfillmentLine`. Actors: User (creates), System (state advances on carrier webhook). Universality: every reference platform — Saleor (`Fulfillment` + `FulfillmentLine` with `status`, `trackingNumber`, `warehouse`), Vendure (`Fulfillment` with `state`, `trackingCode`, `method`, `handlerCode`), Medusa (`Fulfillment` with `location_id`, `packed_at`, `shipped_at`, `delivered_at`, plus separate `FulfillmentLabel`) — has this exact entity with virtually identical structure.
- **FulfillmentLine**. Purpose: which OrderLine quantities are in this shipment. Attributes: `id`, `fulfillmentId`, `orderLineId`, `quantity`. Universality: required to support partial and split shipments, which any non-trivial e-commerce business eventually needs.
- **Payment**. Purpose: a record of a payment attempt against an Order. Attributes: `id`, `orderId`, `amount`, `currency`, `method` (opaque token — actual gateway is external), `status` (authorized | captured | voided | refunded | failed), `gatewayReference`, `authorizedAt`, `capturedAt`. Relationships: N→1 `Order`. Actors: System (writes from gateway webhooks), User (manual ops). Universality: every order has at least one payment attempt; modeling it as an entity (not a column on Order) supports split-tender, retries, and partial captures.
- **Address**. Purpose: a structured postal/contact address. Attributes: `id`, `ownerType`, `ownerId`, `recipientName`, `line1`, `line2`, `city`, `region`, `postalCode`, `country`, `phone`. Relationships: polymorphic to `Customer`, `Order`. Actors: both. Universality: shared across customers and orders; Orders MUST snapshot rather than reference a mutable Customer address.

**Operations** (state-transition vocabulary: reserve, place, allocate, authorize, capture, fulfill, ship, deliver, void, cancel, refund)

- **Add to Cart** (Customer). Trigger: storefront action. Preconditions: Variant active and stocked. Outcome: CartLine appended; `Reserve Stock` invoked (System). Emits `CartLineAdded`.
- **Remove from Cart / Change Quantity** (Customer). Outcome: Reservation adjusted accordingly.
- **Place Order** (Customer). Trigger: checkout submission. Preconditions: all reservations active and unexpired; payment method on file; addresses validated. Outcome: Cart→converted; Order created in `pending` status; Reservations→committed (becomes Allocation); emits `OrderPlaced`.
- **Authorize Payment** (System). Trigger: ordered. Preconditions: payment method present. Outcome: Payment row with status `authorized`; Order.paymentStatus advances.
- **Capture Payment** (System or User). Trigger: shipment ready OR immediately on placement (policy). Outcome: Payment→captured; emits `PaymentCaptured`.
- **Void Authorization** (User or System). Trigger: order cancelled pre-capture. Outcome: Payment→voided.
- **Create Fulfillment** (User). Trigger: warehouse picks and packs. Preconditions: Payment captured (or merchant policy allows capture-on-ship); StockLocation has stock allocated. Outcome: Fulfillment in `pending`; OrderLine statuses advance toward `shipped` proportionally.
- **Ship Fulfillment** (User/System). Trigger: carrier handoff. Outcome: Fulfillment→shipped; `Commit Sale` in Inventory (quantityOnHand decrements); emits `OrderShipped`.
- **Mark Delivered** (System). Trigger: carrier webhook. Outcome: Fulfillment→delivered; if all fulfillments delivered → Order→delivered.
- **Cancel Order** (User or Customer, policy-gated). Trigger: pre-fulfillment cancellation. Preconditions: no shipped fulfillments. Outcome: Order→cancelled; `Cancel Allocation` for each line; Payment→voided or refunded; emits `OrderCancelled`.
- **Cancel Line** (User). Trigger: partial cancellation. Outcome: line-level status change; proportional allocation release.

**Boundary analysis**

- _Minimal slice:_ Cart, Order, OrderLine, Payment, Address, Fulfillment. Even the minimal slice cannot drop Fulfillment without losing the ability to model "shipped" — which then breaks Inventory's commit-sale step.
- _First natural extension point:_ split shipments and multi-warehouse sourcing rules; tax computation (typically a separate domain service or external API like Avalara/TaxJar); shipping rate calculation (carrier API); fraud screening; B2B quote/PO flows.
- _What depends on this cluster:_ Returns (RMA references Order/OrderLine), Notifications (order events drive all transactional messaging), Inventory (allocation/commit chain).

**Exclusions from universal core:** Subscriptions and recurring orders, gift cards, store credit, dropshipping vendor routing, marketplace seller payouts, B2B quote/PO/credit terms, fraud/risk scoring, tax computation (modeled as an opaque `taxAmount` field — computation is an external concern), shipping rate selection (the `shippingAddress` and `carrier` exist; rate engines do not), buy-now-pay-later state machines, replacement orders as a distinct entity (modeled via Returns).

---

### 4. Customer & Identity

**Entities**

- **Customer**. Purpose: the buyer-side identity. Attributes: `id`, `email` (unique, lowercased), `phone`, `firstName`, `lastName`, `passwordHash` (nullable for guest/social), `status` (active | suspended | deleted), `emailVerifiedAt`, `createdAt`. Relationships: 1→N `Address`, 1→N `Order`, 1→1 `ConsentRecord`. Actors: Customer (self-service); User (admin support). Universality: required even when "guests" are supported — guest checkouts still produce a Customer row keyed by email for order lookup and post-purchase contact.
- **Address** — already defined under Order Management; the same entity is shared.
- **ConsentRecord**. Purpose: explicit consent timestamps for transactional contact, marketing, and data retention. Attributes: `customerId`, `transactionalEmail`, `marketingEmail`, `marketingSms`, `dataRetentionPolicy`, `updatedAt`. Universality: not strictly required for a demo, but legally required in any jurisdiction with GDPR/CCPA/UK-DPA exposure. Including a placeholder entity is cheaper than retrofitting.

**Operations**

- **Register Customer** (Customer). Trigger: signup. Preconditions: email unique; password meets policy. Outcome: Customer in `active` status, unverified email.
- **Verify Email** (Customer). Outcome: `emailVerifiedAt` set.
- **Authenticate** (Customer). Outcome: session/token issued.
- **Update Profile** (Customer). Outcome: scalar updates; emits `CustomerUpdated`.
- **Add/Edit/Remove Address** (Customer). Outcome: Address rows mutated; existing Order address snapshots NOT affected.
- **Suspend Customer** (User). Trigger: fraud or policy violation. Outcome: status→suspended; active sessions revoked.
- **Erase Customer** (User, on regulatory request). Outcome: PII fields nulled or pseudonymized; Customer row marked deleted but preserved as a stub so Orders remain referentially intact. See Cross-Cutting and Open Questions.

**Boundary analysis**

- _Minimal slice:_ Customer + Address.
- _First natural extension point:_ loyalty profile, segments, wishlists, preference centers, B2B account hierarchies (Company → BusinessUnit → Customer), social-identity federation, multi-factor authentication policies.
- _What depends on this cluster:_ Order Management (every Order has a Customer reference), Notifications (channel preferences), Returns (RMA authorization).

**Exclusions from universal core:** Loyalty programs, tier/segment membership, B2B company hierarchies, wishlists, saved carts beyond the active one, social logins (the authentication entity exists; specific providers are infrastructure), MFA tokens, customer notes/CRM tags, household grouping (ARTS models it, but no universal need).

---

### 5. Returns & Refunds

**Entities**

- **ReturnRequest** (or RMA). Purpose: a customer-initiated or staff-initiated request to return goods. Attributes: `id`, `rmaNumber`, `orderId`, `customerId`, `status` (requested | authorized | rejected | received | inspected | closed), `reasonCategory`, `notes`, `requestedAt`, `authorizedAt`. Relationships: N→1 `Order`, 1→N `ReturnLine`, 1→N `Refund`. Actors: both. Universality: required wherever physical goods are sold remotely; Adobe Commerce documents an RMA lifecycle of Pending → Authorized → Received → Approved/Denied → Closed that mirrors what Vendure, ReverseLogix, and ShipBob describe — a near-unanimous convergence.
- **ReturnLine**. Purpose: which OrderLine quantities are being returned and their disposition. Attributes: `id`, `returnRequestId`, `orderLineId`, `quantity`, `condition` (new | damaged | used), `disposition` (restock | scrap | quarantine), `lineRefundAmount`.
- **Refund**. Purpose: the financial counterparty to a return (or a goodwill credit). Attributes: `id`, `orderId`, `paymentId`, `amount`, `currency`, `status` (pending | issued | failed), `reason`, `issuedAt`. Relationships: N→1 `Order`, N→1 `Payment`. Universality: a refund can exist without a physical return (compensation, goodwill) so it is separated from ReturnRequest.

**Operations**

- **Open Return Request** (Customer or User). Outcome: ReturnRequest in `requested`. Emits `ReturnRequested`.
- **Authorize Return** (User). Preconditions: original Order eligible by policy (window, condition). Outcome: status→authorized; emits `ReturnAuthorized`. Optionally generates return shipping label (label generation is out of core).
- **Reject Return** (User). Outcome: status→rejected.
- **Receive Return** (User). Trigger: parcel arrives at warehouse. Outcome: status→received.
- **Inspect & Disposition** (User). Trigger: warehouse inspection. Outcome: per-ReturnLine disposition recorded; `Restock from Return` invoked in Inventory for `restock` dispositions.
- **Issue Refund** (User or System). Preconditions: Payment exists and is captured. Outcome: Refund row; Payment→partially or fully refunded; emits `RefundIssued`.

**Boundary analysis**

- _Minimal slice:_ ReturnRequest + ReturnLine + Refund. Even a "no returns" merchant needs Refund (chargebacks, goodwill).
- _First natural extension point:_ exchanges as first-class entities, repair workflows, return shipping label generation, automated fraud detection on serial returners, gift-card-as-refund-method.
- _What depends on this cluster:_ Inventory (restock path), Notifications (RMA status messages), Payments (refund chain).

**Exclusions from universal core:** Exchange-as-entity (model as Return + new Order), repair workflows, advance replacement, vendor RMAs (return to supplier), refund-to-store-credit, automated return fraud scoring.

---

### 6. Pricing & Promotions (universal subset only)

**Entities**

- **Price**. Purpose: the listed monetary value of a variant in a given currency/scope at a given time. Attributes: `id`, `variantId`, `currency` (ISO-4217), `amount` (integer minor units), `validFrom`, `validTo` (nullable), `priority`. Relationships: N→1 `ProductVariant`. Actors: both (Customer reads, User writes). Universality: commercetools defines a `Price` as "the purchase value of a Product Variant, or SKU, in a specific currency" with uniqueness determined by "price scope (currency, country, Customer Groups, or Channels)"; Saleor, Shopify, and Vendure model price as an entity separate from product for the same reasons — multi-currency, scheduled price changes, historical pricing for analytics.
- **TaxCategory** (label only). Purpose: classifies a variant into a tax bucket (e.g., "standard", "reduced", "exempt"). Attributes: `id`, `code`, `name`. Relationships: 1→N `ProductVariant`. Universality: even when actual tax rates are external, the _classification_ is intrinsic to the product. Actual tax rates are out of scope.

**Operations**

- **Set Price** (User). Outcome: new Price row (often append-only for history); emits `PriceChanged`.
- **Schedule Price** (User). Outcome: Price with future `validFrom`.
- **Select Applicable Price** (System). Trigger: storefront render, cart add. Outcome: deterministic resolution by currency, scope, validity, priority.

**Boundary analysis**

- _Minimal slice:_ a single Price row per variant per currency. Time-bounding is the first thing you add.
- _First natural extension point:_ customer-group pricing, tiered/volume pricing, B2B contract prices, discount/promotion rules, coupon codes, cart-level discounts, dynamic pricing. ALL are excluded from the universal core.
- _What depends on this cluster:_ Order Management (line `unitPriceSnapshot` resolves through here).

**Exclusions from universal core:** Discounts, promotions, coupons, gift cards, customer-group pricing, B2B contract pricing, tiered pricing, dynamic/AI pricing, tax rate computation and jurisdiction tables, currency conversion, MSRP vs sale price (commercetools recommends modeling sale prices via Product Discount rather than overloading base price). These are exactly the "custom pricing engines" called out as out-of-scope by the user.

---

### 7. Notifications & Events

**Entities**

- **NotificationTemplate**. Purpose: a named, parameterized message body for a given event type and channel. Attributes: `id`, `eventType`, `channel` (email | sms | push | webhook), `locale`, `subject`, `body`, `version`. Actors: User. Universality: even an MVP needs "order confirmation email"; templating is core to keeping content out of code.
- **NotificationDelivery**. Purpose: a record of an attempted delivery. Attributes: `id`, `templateId`, `recipientCustomerId`, `recipientAddress` (email/phone), `eventReferenceId`, `status` (queued | sent | delivered | failed | bounced), `attemptCount`, `lastAttemptAt`. Actors: System. Universality: required to debug "the customer says they didn't get the email."
- **DomainEvent**. Purpose: the append-only canonical log of business-significant occurrences. Attributes: `id`, `type` (e.g., `OrderPlaced`), `aggregateType`, `aggregateId`, `payload`, `occurredAt`, `producer`, `correlationId`. Universality: any system above three services needs an event log; including it explicitly avoids implicit drift.

**Operations**

- **Emit Domain Event** (System). Trigger: any state-machine transition flagged as event-producing. Outcome: DomainEvent persisted; consumers fan out asynchronously.
- **Render & Dispatch Notification** (System). Trigger: NotificationTemplate matched to DomainEvent. Preconditions: ConsentRecord permits the channel. Outcome: NotificationDelivery row created and pushed to channel provider.
- **Record Delivery Outcome** (System). Trigger: provider webhook. Outcome: NotificationDelivery status updated.
- **Author Template** (User). Outcome: new template version persisted.

**Boundary analysis**

- _Minimal slice:_ NotificationTemplate + NotificationDelivery; DomainEvent can be implicit at first but becomes mandatory the moment you add a second service consuming order state.
- _First natural extension point:_ multi-channel orchestration (fallback push→sms→email), preference centers, marketing campaigns, abandoned-cart sequences, scheduled batch notifications, A/B template testing, in-app inbox.
- _What depends on this cluster:_ Customer (consent), all state-changing clusters (events).

**Exclusions from universal core:** Marketing campaigns, segmentation, A/B testing, abandoned-cart automation, in-app inbox/feed, customer messaging/chat, push device token registration as a first-class entity (lives under Customer or extension), webhook subscription management UI for third-party integrators (an extension), scheduled batch newsletters.

---

### 8. Staff & Access Control

**Entities**

- **StaffUser**. Purpose: an employee identity authorized to operate admin functions. Attributes: `id`, `email`, `passwordHash`, `status` (active | suspended), `lastLoginAt`. Relationships: N↔M `Role`. Universality: kept separate from `Customer` because mixing them creates serious authorization-by-confusion bugs.
- **Role**. Purpose: a named bundle of permissions (e.g., "WarehouseStaff", "OrderSupport", "CatalogManager"). Attributes: `id`, `name`, `description`. Relationships: N↔M `Permission`.
- **Permission**. Purpose: an atomic capability string (e.g., `order:cancel`, `inventory:adjust`, `catalog:write`). Attributes: `id`, `code`, `description`. Universality: explicit permission entities (RBAC) are the consensus model; ABAC and scoped roles are extensions.
- **AuditLogEntry**. Purpose: who did what when, for any administrative state change. Attributes: `id`, `actorId`, `actorType`, `action`, `entityType`, `entityId`, `before`, `after`, `occurredAt`, `ipAddress`. Universality: legally and operationally required wherever staff can change inventory, prices, orders, or refunds.

**Operations**

- **Authenticate Staff** (User). Outcome: session token; AuditLogEntry written.
- **Assign Role** (User). Preconditions: caller has `iam:assign`. Outcome: StaffUser↔Role link; audit entry.
- **Create/Modify Role** (User). Outcome: role-permission mapping changes; audit entry.
- **Authorize Action** (System). Trigger: every admin operation. Outcome: permit/deny based on intersection of StaffUser roles' permissions and the action's required permission.

**Boundary analysis**

- _Minimal slice:_ StaffUser + Role + Permission + AuditLogEntry. Cannot be reduced further without breaking the segregation-of-duties property.
- _First natural extension point:_ scoped/contextual roles (e.g., "Manager of Warehouse X only"), ABAC policies, SSO/SAML/OIDC federation, MFA enforcement, separation-of-duties rules between sensitive permission pairs, time-bound role grants.
- _What depends on this cluster:_ every cluster — every write-side operation routes through authorization.

**Exclusions from universal core:** SSO federation, MFA, scoped/tenant-aware roles, dynamic ABAC policies, approval workflows (e.g., "refunds above $X require manager approval"), session device management, IP allowlists, staff scheduling/shifts (HR domain, not retail).

---

## Cross-Cutting Concerns

**1. Concurrency & consistency.** The single hardest invariant in the universal core is _no oversell_. The atomic guarantee belongs on `StockLevel.quantityOnHand − quantityAllocated − quantityReserved ≥ requested`. This requires (a) optimistic concurrency on `StockLevel` (the `version` attribute) at minimum, and (b) the Reservation entity to be inserted in the same transaction as the StockLevel counter update. `Order` placement is itself transactional but does not require pessimistic locking; payment authorization is naturally idempotent via gateway tokens. `Cart` mutations should be optimistically locked per cart to prevent cart-line duplication under double-clicks. Everything else — catalog, customer profile, templates — needs only last-writer-wins.

**2. Event emission.** State transitions that MUST emit a DomainEvent: `ProductPublished`, `ProductArchived`, `StockReserved`, `StockAllocated`, `StockCommitted` (sale), `StockReleased`, `OrderPlaced`, `OrderCancelled`, `PaymentAuthorized`, `PaymentCaptured`, `PaymentRefunded`, `FulfillmentShipped`, `FulfillmentDelivered`, `ReturnRequested`, `ReturnAuthorized`, `RefundIssued`, `CustomerRegistered`, `CustomerErased`. Consumers split cleanly: storefront-facing projections (read models, search indexes, availability views) consume catalog and stock events; customer-facing notification dispatcher consumes order/fulfillment/return events; staff-facing dashboards consume all of the above plus audit; internal integrators (ERP, accounting, BI) consume the full firehose. Events must be versioned by event type from day one.

**3. Auditability.** Required for: every entity mutated by a StaffUser (StaffUser actions go to `AuditLogEntry`), every `StockMovement` (immutable by construction), every `Payment` and `Refund` (financial), every `Order` status transition (regulatory and dispute), every `Price` change (consumer-protection in many jurisdictions). NOT required at the same fidelity for: catalog content edits (versioning is sufficient), customer profile changes (the customer's own history), notification template authoring.

**4. Multi-location / multi-warehouse.** `StockLocation`, `StockLevel`, `StockMovement`, and `Reservation` are location-aware at the universal core level. `Fulfillment` is location-aware. `Order` is NOT location-aware at the header level — sourcing is a per-line/per-fulfillment property. `Price` is deliberately NOT location-aware in the universal core; per-store pricing is an extension that lifts naturally via a `priceScope` field. `Customer` and `Address` are not location-aware.

**5. Soft delete vs hard delete.**

- _Soft delete (deactivate):_ Product, ProductVariant, Category, MediaAsset, Price, NotificationTemplate, StaffUser, Role — these are referenced by historical records and must remain resolvable. Use a `status` field, not `deletedAt`.
- _Hard delete (or anonymize):_ Customer PII fields on lawful erasure request — the Customer row itself becomes a tombstone retaining only `id` and `status='deleted'` to preserve referential integrity from Orders. ConsentRecord can be hard-deleted after retention window.
- _Append-only, never delete:_ StockMovement, DomainEvent, AuditLogEntry, Payment, Refund, Order, OrderLine, Fulfillment, ReturnRequest. Cancellation is a state transition, not a deletion.
- _Live ephemeral:_ Cart, Reservation, NotificationDelivery older than retention — periodically purged.

---

## Dependency Narrative

At the foundation sits **Staff & Access Control**: every write operation in every other cluster passes through it. Independently at the base sits **Customer & Identity**, which is read by everything Customer-facing but writes only to itself.

**Product Catalog** depends on neither and is a root of the catalog-side graph. **Pricing** depends only on Product Catalog (Price references ProductVariant). **Inventory** also depends only on Product Catalog (StockLevel references ProductVariant) plus its own StockLocation.

**Order Management** is the convergence point: it depends on Product Catalog (variant references on OrderLine and CartLine), Pricing (snapshotted), Inventory (Reservation→Allocation→Sale), and Customer (the buyer). Within Order Management, Cart is the upstream of Order; Payment and Fulfillment are downstream children of Order; Fulfillment depends back on Inventory's StockLocation to know where it ships from.

**Returns & Refunds** depends on Order Management (RMA references Order/OrderLine), Inventory (restock path back into StockLevel), and Payment (Refund chains off Payment).

**Notifications & Events** sits orthogonally — it depends on every state-changing cluster for its event sources and on Customer for consent and delivery addresses. Nothing depends on Notifications structurally; downstream consumers tolerate notification failure.

If you remove Inventory, Order Management cannot guarantee fulfillability. If you remove Order Management, nothing meaningful happens — the system becomes a static catalog. If you remove Customer, you cannot model who placed any order. If you remove Staff & Access Control, you cannot safely operate the admin side. If you remove Product Catalog, you have a system that sells nothing. If you remove Notifications, the system still works internally but provides zero communication to customers. If you remove Returns, you cannot legally operate in most jurisdictions. If you remove Pricing, orders cannot be priced.

---

## Open Questions & Decisions

**Q1 — Cart ownership and persistence.** Should `Cart` be a persistent entity or an ephemeral session artifact? _Alternative A:_ persistent, server-side, identified entity that can be reopened across devices for authenticated customers. _Alternative B:_ ephemeral, client-side or session-store-only. **Recommendation:** persistent for authenticated customers, ephemeral-but-promoted-to-persistent on login for guest sessions. Cart MUST be an entity because Reservation references it. **Downstream impact:** significant — drives the Reservation cluster and abandoned-cart event emission.

**Q2 — Pre-checkout Reservation: explicit entity or implicit counter?** _Alternative A_ (Saleor's `Stock.quantityReserved`, Medusa's `ReservationItem`): explicit Reservation concept with TTL, status, cartId. _Alternative B_ (Vendure): no pre-checkout reservation; only firm `Allocation` StockMovement at order time, with available stock computed as `stockOnHand − stockAllocated`. **Recommendation:** explicit Reservation entity. The Vendure approach is defensible only because Vendure's `Allocation` is "created for each ProductVariant in an Order when the checkout is completed" — i.e., it doesn't prevent two carts from racing for the last unit before checkout completion. Modern e-commerce expects "1 left!" UX and reservation-on-add-to-cart. **Downstream impact:** medium — adds one entity and a TTL sweep job.

**Q3 — Cart-to-Order: same aggregate or distinct aggregates?** _Alternative A:_ Cart and Order are the same entity with a status field. _Alternative B:_ distinct aggregates with a one-shot conversion. **Recommendation:** distinct aggregates. Cart is mutable, Order is immutable; conflating them produces lifecycle bugs (e.g., post-placement edits to "the cart" corrupting the order record). **Downstream impact:** high — affects every downstream consumer's contract.

**Q4 — Single Order state field vs separate paymentStatus/fulfillmentStatus.** _Alternative A:_ a single composite state machine. _Alternative B_ (Adobe Commerce, commercetools): separate `paymentStatus` and `fulfillmentStatus` plus a high-level `status`. **Recommendation:** separate substates. Real orders have paid-but-unshipped and shipped-but-unpaid (B2B-on-terms) and partial-shipped states that a single enum cannot cleanly express. **Downstream impact:** medium — affects API and UI projections.

**Q5 — Payment capture timing.** _Alternative A:_ capture on order placement. _Alternative B:_ authorize on placement, capture on ship. **Recommendation:** authorize on placement, capture on ship, as the default policy; expose capture as an explicit operation so other policies are achievable. **Downstream impact:** low — both policies fit the entity model.

**Q6 — Right-to-be-forgotten implementation.** _Alternative A:_ hard delete Customer row. _Alternative B:_ tombstone (null PII; preserve id). **Recommendation:** tombstone. Hard-deleting customer rows orphans Orders, which is unacceptable for tax, dispute, and accounting reasons. The Customer row remains as `{ id, status: 'deleted' }` and all PII columns are nulled or pseudonymized. **Downstream impact:** medium — affects every read path that touches Customer.

**Q7 — Guest checkout: Customer entity or not?** _Alternative A:_ every order produces a Customer (even guests). _Alternative B:_ `Order.customerId` is nullable; guest contact info lives only on the Order. **Recommendation:** every order produces a Customer, distinguished by `status='guest'` or a boolean. Single lookup path; trivial future account-claim. **Downstream impact:** low.

**Q8 — How many StockLocations in a minimal install?** _Alternative A:_ zero — model only "available quantity" on the variant. _Alternative B:_ exactly one default. **Recommendation:** exactly one default, auto-provisioned as Vendure does ("you can simply use the default location which is created automatically"). The location is an unavoidable abstraction the moment a second warehouse appears; making it optional creates a migration hazard. **Downstream impact:** high — pervades Inventory and Fulfillment.

**Q9 — Reservation TTL.** _Alternative A:_ short (5–15 minutes), aggressive release. _Alternative B:_ long (24 hours), generous. **Recommendation:** short TTL (~15 minutes) with explicit refresh on cart interaction, and immediate commit on order placement. **Downstream impact:** low; tune per business.

**Q10 — Idempotency of payment and order-placement operations.** _Alternative A:_ idempotency keys required on inbound operations. _Alternative B:_ server detects duplicates heuristically. **Recommendation:** require client-supplied idempotency keys on `Place Order` and `Capture Payment`. **Downstream impact:** low but pervasive at API contract level.

---

## Exclusions Register

Every excluded item is universally retail-relevant but NOT universally retail-required.

**Product Catalog**

- Product bundles/kits — extension; vertical-specific compositions.
- Dynamic typed attribute schemas (commercetools-style ProductType) — extension; YAGNI in v1.
- Configurable products with option dependencies — extension; rare outside apparel/furniture.
- Digital good entitlements — extension; not universal.
- Subscriptions / selling plans — extension.
- Product relations / recommendations — extension; usually external.
- Brand entity — modeled as Category or as an extension.
- Supplier / vendor — belongs in Procurement bounded context.
- Multi-locale translation tables — extension via translation overlays.

**Inventory**

- Lot / batch / serial number tracking — regulated industries only.
- Expiry / FIFO rotation — perishables only.
- Bin / aisle / shelf — WMS, not IMS.
- Demand forecasting / safety stock — analytics extension.
- Transfer-order documents — basic transfer movements are core; the workflow document is an extension.
- Consigned / vendor-managed inventory — extension.
- ABC classification — analytics extension.
- In-transit as separate location — extension.

**Order Management**

- Subscriptions, recurring orders — extension.
- Gift cards, store credit — extension.
- Dropshipping vendor routing — extension.
- Marketplace seller payouts — extension.
- B2B quote / PO / credit terms — extension.
- Fraud / risk scoring — extension (typically external).
- Tax computation engine — external service; `taxAmount` is captured but not computed in core.
- Shipping rate engine — external service.
- BNPL state machines — extension.
- Replacement orders as a distinct entity — modeled via Returns + new Order.

**Customer & Identity**

- Loyalty programs — extension (explicitly out of scope per user).
- Customer segments / tiers — extension.
- B2B company hierarchies — extension.
- Wishlists — extension.
- Social login providers — infrastructure detail.
- MFA, household grouping, CRM tags — extensions.

**Returns & Refunds**

- Exchanges as a first-class entity — model as Return + new Order.
- Repair workflows — extension.
- Advance replacement — extension.
- Vendor RMAs — Procurement domain.
- Refund-to-store-credit — extension.
- Return-fraud scoring — extension.

**Pricing & Promotions**

- Discounts and promotions — extension (explicitly out of scope per user).
- Coupons / discount codes — extension.
- Gift cards (as tender) — extension.
- Customer-group pricing, tiered/volume pricing — extension.
- B2B contract pricing — extension.
- Dynamic / AI pricing — extension.
- Tax rate tables and jurisdiction logic — external.
- Currency conversion — infrastructure.
- MSRP vs sale price modeling — modeled via discount extension.

**Notifications & Events**

- Marketing campaigns and segmentation — extension.
- A/B template testing — extension.
- Abandoned-cart automation — extension.
- In-app inbox / feed — extension.
- Live customer messaging / chat — separate domain.
- Push device-token registration — extension under Customer.
- Webhook subscription management UI — extension.
- Scheduled batch newsletters — extension.

**Staff & Access Control**

- SSO / SAML / OIDC federation — infrastructure.
- MFA enforcement — infrastructure.
- Scoped / tenant-aware roles — extension.
- Dynamic ABAC policies — extension.
- Approval workflows (e.g., "refunds over $X") — extension.
- Session device management, IP allowlists — infrastructure.
- Staff scheduling / shifts — HR domain.

**Physical retail entities explicitly omitted per user scope:** POS terminal, Drawer/Till, Cash Pickup, Cashier Session, ShelfTag, PlanogramSlot, in-store hardware peripherals. None of these are necessary for an e-commerce-first universal core; physical retail extensions reuse `StockLocation` and add a parallel `StoreSession`/`POSTransaction` aggregate.

---

## Recommendations (staged, with thresholds)

**Stage 1 — Walking skeleton (target: end-to-end purchase).** Implement Product, ProductVariant, Price, StockLocation (one default), StockLevel, Cart, CartLine, Order, OrderLine, Payment, Customer, Address, StaffUser, Role, Permission, plus the operations: Register Product, Add Variant, Publish, Add to Cart, Place Order, Authorize Payment, Capture Payment. Skip Fulfillment, Reservation, Returns, Notifications. This proves the catalog→order→payment chain. **Move to Stage 2 when:** the chain works in development with one concurrent user.

**Stage 2 — Production-shaped core.** Add Reservation, StockMovement, Fulfillment, FulfillmentLine, ReturnRequest, ReturnLine, Refund, NotificationTemplate, NotificationDelivery, DomainEvent, AuditLogEntry, MediaAsset, Category. Wire all event emissions. Implement Cancel Order, Ship Fulfillment, Restock from Return, Issue Refund. **Move to Stage 3 when:** concurrent oversell tests pass and an end-to-end order→ship→return→refund cycle works.

**Stage 3 — Hardening.** Add idempotency keys to mutating operations, optimistic concurrency on StockLevel/Cart, ConsentRecord and the tombstone-erase path, reservation TTL sweeper, audit log queries. **Stop here for a portfolio project.** Beyond this is extension territory.

**Thresholds that change these recommendations:**

- If the target vertical is grocery or pharma: add lot/batch/expiry to Stage 2.
- If B2B-first: promote Quote and Approval to Stage 2; the universal core is still correct but feels thin.
- If a second physical store appears: nothing changes — `StockLocation` already supports it; only Fulfillment routing logic ("which location ships this line?") needs implementation, and that is the first natural extension.
- If multi-currency at launch: ensure Price.currency is enforced and Order.currency immutable; no schema change.

---

## Caveats

The 28-entity count is the minimum that delivers a coherent, production-shaped retail core; you can produce a demo with 12 entities (drop Reservation, StockMovement, Refund-as-entity, MediaAsset, Category, ConsentRecord, AuditLogEntry, DomainEvent), but each omission turns into a known-debt item. The Vendure-versus-Saleor/Medusa disagreement on explicit Reservation is the most consequential source-disagreement encountered — Vendure's `StockMovement` is an abstract class with exactly four/five concrete subtypes (`Allocation`, `Cancellation`, `Release`, `Sale`, `StockAdjustment`) and no Reservation primitive, while Saleor exposes `Stock.quantityReserved: Int!` "for checkouts" and Medusa makes `ReservationItem` a first-class data model. The recommendation to keep an explicit Reservation entity is a judgement call, not a unanimous-consensus finding. The ARTS ODM 7.3 models considerably more than this core (Party, Household, Wallet, Customer Lifecycle, Membership Programs, Rewards) — the universal subset extracted here is intentionally narrower because ARTS is a superset reference for large retailers, not a minimum core. Finally, the "no scale assumptions" constraint means the model says nothing about read-model projections, search indexing, or denormalized availability caches; production scale-out introduces those without changing the entity set.