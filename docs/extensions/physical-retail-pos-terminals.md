---
title: Point of sale — terminals, tills and the shop floor
cluster: Physical Retail
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts
  - apps/retail-microservice/src/modules/orders/domain/order.model.ts
  - apps/retail-microservice/src/modules/orders/application/ports/payment-gateway.port.ts
  - apps/catalog-microservice/src/modules/pricing/
---

# Point of sale — terminals, tills and the shop floor

## Description

**Point of sale** is everything that happens when a shopper buys something by carrying it to a
counter instead of clicking a button. It is a whole face of retail that this system has never had,
and it is one file rather than seven because it arrives as one decision.

Seven pieces make up the surface:

| Piece | What it is |
| --- | --- |
| **POS terminal** | The registered device a sale is rung up on — identity, its store, its configuration, its software version. |
| **Drawer / Till** | The physical cash drawer bound to a terminal, with an opening float and a running expected balance. |
| **Cashier session** | The accountability window: a named person opens a drawer, sells for a few hours, counts it and closes it. Every discrepancy is attributable to exactly one of these. |
| **Cash pickup** | Cash removed mid-session to a safe or a bank deposit, so a drawer never holds more than the insured limit. |
| **Shelf tag** | The printed price label on the shelf edge — which in many jurisdictions is a *binding offer*, not a decoration. |
| **Planogram slot** | Where a product is *displayed*: which fixture, which shelf, how many facings. Merchandising, not picking. |
| **In-store peripherals** | Barcode scanners, receipt printers, card readers, customer displays, scales, label printers — hardware sitting on a shop's LAN. |

**Why one guide and not seven.** These are not seven capabilities a reader might want one of. Nobody
adopts a cash drawer without a till to bind it to, or a cashier session with nothing to reconcile, or
a shelf tag for a shop that has no shelves. They are the consequences of a single decision — *this
business also sells across a counter* — and every one of them becomes necessary on the same day.
Splitting them into a menu would imply choices that do not exist, and would hide the only genuinely
interesting question, which cuts across all seven: **is a till sale an `Order`, or something
parallel to one?** That question is answered below, and it is the reason this guide is worth
reading.

Every serious commerce platform answers it, and they disagree. Shopify POS and Lightspeed model an
in-store sale as an order in the same ledger as an online one; Square grew up from the till and
treats an online order as the visitor. Vendure, Saleor and commercetools ship no point of sale at
all and leave it to partner integrations — which is the same decision this core has made.

## Business needs

- **The first physical door.** A pure e-commerce business needs none of this. The moment there is one
  shop, every one of the seven pieces is needed at once, and the interesting cost is not the till
  software — it is that stock, price and customer identity now have to be true in two places.
- **Omnichannel is the actual reason.** Buy-online-pick-up-in-store, ship-from-store, return-in-store
  and endless-aisle all require the shop floor and the web store to read the same stock and write the
  same ledger. A separately-bought till product gives a business two systems and a nightly file.
- **Cash accountability.** Cash is the one tender that walks away. The cashier session exists so that
  a discrepancy has exactly one name and one time window attached to it, and cash pickups exist so
  that the amount at risk in a drawer stays under an insured ceiling.
- **Shelf-price accuracy is a legal exposure**, not a tidiness concern. In much of Europe and North
  America the displayed price binds the seller, and a promotion that reaches the website but not the
  shelf edge is a compliance failure with a per-incident cost.
- **Staff throughput at the counter.** A queue is measured in seconds per transaction, which is why a
  till is the one client in a retail estate that cannot afford a round trip it does not need.
- **Continuity when the network is down.** A shop whose till stops selling when the connection drops
  is a shop that closes. This is the single hardest constraint in the whole surface, and it is what
  makes point of sale structurally different from every other client this system has.

## Attachment points in the current core

- **A store is already a kind of location.** `StockLocationTypeEnum` at
  `apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts` is
  `warehouse | store | dropship-virtual` — `store` is there, and the aggregate carries a
  caller-assigned string primary key, a `code`, an optional 13-digit GLN and an `active` flag it
  soft-deletes with. Nothing about physical retail needs a second notion of *place*: a shop is a
  `StockLocation` of type `store`, and every reservation, allocation and movement already keys on
  `stockLocationId`.
- **`Order` tolerates far more than it looks like it does.** At
  `apps/retail-microservice/src/modules/orders/domain/order.model.ts`, `customerId` is
  `string | null` — a walk-in shopper is already representable — and `billingAddressId` /
  `shippingAddressId` are nullable too. The often-repeated objection that "an order needs an address"
  is simply false here: `PlaceOrderUseCase` **passes `null` for both** at construction and patches
  them afterwards, because the address rows FK onto the order row. The three status axes
  (`status`, `paymentStatus`, `fulfillmentStatus`) are independent and none is derivable from
  another (ADR-028), which is exactly the flexibility a counter sale needs.
- **The real coupling is the cart, not the address.** `PlaceOrderUseCase` begins with a `cartId`,
  loads the cart, rejects it unless `cart.customerId` equals the caller, snapshots its lines,
  compare-and-swaps it to `converted` inside the place transaction, and uses
  `findBySourceCartId` as its repeat-place idempotency. A till has no cart in this sense — the
  "cart" is a scan list living in the terminal's memory for ninety seconds. **This use case, not the
  `Order` aggregate, is what a counter sale cannot reuse.**
- **`PAYMENT_GATEWAY` is reusable in two of its three operations.** The port at
  `apps/retail-microservice/src/modules/orders/application/ports/payment-gateway.port.ts` types
  `capture(gatewayReference, correlationId)` and `refund({ gatewayReference, amountMinor, … })`
  against an **opaque reference** — those work for any tender. But `authorize` takes
  `orderId: number`. The seam is card-not-present in shape: it assumes an order exists before money
  is asked for, which at a counter is backwards. The bound adapter is a fake that always approves,
  and card-present processing is a genuinely different integration — a terminal talks to a payment
  *device*, not to an HTTPS endpoint. The root
  [`README.md` § Not built yet](../../README.md#14-not-built-yet) already records the real-processor
  gap; card-present is the sharper end of it.
- **`Payment` and `Refund` are structurally bound to an order.** Both carry `orderId: number`,
  validated as a positive integer in the constructor. There is no polymorphic owner here — unlike
  `Address`, which does carry an `ownerType`, and `MediaAsset`, whose `owner_id` is deliberately
  FK-less. **Anything modelled parallel to `Order` therefore needs a parallel payment record, or a
  widening of these two.** This is the single largest cost in the design question below, and it is
  invisible until the models are opened.
- **The stock-commitment path assumes an allocation that a till sale never had.**
  `StockLevel.commitSale` throws a plain `Error` — an internal-bug 500, not a typed rejection —
  when `quantity > quantityAllocated`, on the stated reasoning that fulfillment lines are always
  built from the order's own allocation. A counter sale has no reservation and no allocation: the
  units are in the shopper's hands. Calling `inventory.stock.commit-sale` for a till sale as it
  stands would fail the drift guard, and the operation is keyed on a `fulfillmentId` besides.
- **The movement ledger, by contrast, absorbs a till sale with no schema change at all.**
  `stock_movement.reference_type` and `reference_id` are plain nullable `VARCHAR(32)` / `VARCHAR(64)`
  columns, polymorphic and FK-less by design, and the codebase already writes five different values
  into them (`fulfillment`, `order`, `cart`, `transfer`, `return-request`). `StockMovementTypeEnum`
  already has `SALE` with its fixed negative sign. A `counter-sale` reference type is a new string,
  not a migration.
- **Returns are where the design question stops being academic.** `RETURN_ORDER_READER` reads raw SQL
  over `order` / `order_line` / `fulfillment` and cannot import the orders module at all
  (ADR-032, and the boundaries lint). Worse,
  `assertWithinReturnWindow` treats `DELIVERED` as always returnable, `SHIPPED` /
  `PARTIALLY_SHIPPED` as returnable within `RETURN_WINDOW_DAYS` of the ship date, and **every other
  fulfillment state — including `unfulfilled` — as not returnable at all.** A till sale recorded as
  an order that never ships would be permanently non-returnable, and one recorded as a parallel
  aggregate would be invisible to the entire RMA context. Both answers cost something here; neither
  is free.
- **Pricing has exactly one scope axis, and location is the named omission.**
  `apps/catalog-microservice/src/modules/pricing/` keys the append-only `price` ledger on
  `(variantId, currency)`, enforced by the generated `open_scope_key` column. ADR-026 §2 states that
  this is the entire scope surface and that **location**, sales channel and customer tier are
  deliberately deferred. A shelf tag is a price *for a store*, so shelf tags cannot be honest until
  that axis is lifted — which is the work
  [`customer-group-and-tiered-pricing.md`](customer-group-and-tiered-pricing.md) describes from the
  customer-group side. The `catalogPrice` cache builders exist and have no caller yet.
- **The permission registry has no physical-retail vocabulary.** `PermissionCodeEnum` holds
  twenty-two codes across catalog, inventory, order, notifications, IAM, audit, pricing and customer
  concerns; opening a drawer, voiding a line and approving a discrepancy are none of them. A new code
  is not live merely by being added to the enum — the seeded role bundles have to grant it.
- **The audit seam takes till events, with a known shape.** `AuditTargetKind` is the closed union
  `staff-user | customer | role | permission`, so a drawer, a session and a terminal fit none of
  them. The precedent already exists: the refund path sets `targetKind: null` and carries its
  identifiers in the payload. Session and drawer events follow it, and — as everywhere — the `action`
  is an event name such as `DrawerCountReconciled`, **never** a permission code.
- **Nothing in this repository talks to hardware, and nothing can.** All six deployables are
  server-side Nest applications communicating over RabbitMQ (ADR-018), and a receipt printer sits on
  a shop's LAN behind a domestic router. There is no attachment point for a peripheral, and that
  absence is itself the finding: peripherals need a client, not a service.

## Implementation sketch

**The design question, answered: a counter sale is an `Order`, reached by a second creation path.**

The tempting alternative — a parallel `POSTransaction` aggregate — reads cleanly until the models are
opened, and then it costs four things, each verified above: a parallel `Payment` (its `orderId` is a
validated positive integer), a parallel `Refund` for the same reason, a parallel returns context (the
RMA reader is raw SQL over the order tables and is forbidden from importing anything else), and a
reporting layer that must union two aggregates for every question a retailer actually asks — daily
takings, units sold, margin by variant. The parallel model buys purity in the sale and pays for it in
every consumer downstream of the sale.

Reusing `Order` costs two things, and both are edits rather than duplications:

- **A `PlaceCounterSaleUseCase` beside `PlaceOrderUseCase`**, taking scanned lines directly rather
  than a `cartId`, with no ownership check (there may be no customer), no cart conversion, and
  idempotency keyed on the terminal's own transaction identifier instead of `sourceCartId`. It
  reuses line snapshotting, the order factory, the address-free construction path that already
  exists, and the OCC retry protocol unchanged.
- **A fulfillment that completes at the counter.** The goods are handed over as the sale is rung up,
  so the sale writes a `Fulfillment` immediately and the order lands on
  `fulfillmentStatus: delivered` — which makes it returnable under the *existing* rule rather than
  needing a new one. This is the small edit that pays for itself: without it the sale is
  permanently `unfulfilled` and the RMA context refuses it by design.

The remaining pieces, by where they attach:

| Piece | Where it lives | Shape |
| --- | --- | --- |
| POS terminal | a new `modules/pos/` in `retail-microservice` | A registry aggregate: terminal id, its `stockLocationId`, configuration, active flag. Caller-assigned string PK, as `StockLocation` uses. |
| Drawer / Till | ″ | Bound one-to-one to a terminal; holds no balance of its own — the balance is derived. |
| Cashier session | ″ | The mutable aggregate: opened by a `StaffUser`, an opening float, a close with a counted amount and a computed variance. |
| Cash pickup | ″ | A row on the cash ledger below, not an aggregate of its own. |
| Shelf tag | beside pricing, in `catalog-microservice` | A print-and-approve lifecycle over a price the pricing ledger owns; it stores what was printed and when, never a second price. |
| Planogram slot | ″ | Fixture / shelf / position / facings, keyed on `variantId`. |
| Peripherals | not in this repository | A local agent at the store — see below. |

- **Cash is an append-only ledger with a derived balance**, structurally identical to
  `stock_movement`: signed entries (`float-in`, `sale`, `refund`, `pickup`, `count-adjustment`) with a
  fixed sign per type, never updated, and an expected balance that is a fold rather than a column.
  This is the shape the codebase already reaches for twice, and it is the right one here for the same
  reason — a cash drawer is audited, not balanced.
- **A cash tender is a `Payment` with `method: 'cash'`.** `Payment.method` is an opaque non-empty
  string that retail stores and never parses, so no enum widens. The same reasoning
  [`gift-cards-and-store-credit.md`](gift-cards-and-store-credit.md) applies to store credit applies
  here, and split tender across cash and card is the same multi-payment-row question that guide
  raises.
- **A new `inventory.stock.commit-counter-sale` operation**, rather than bending
  `commit-sale`. It decrements on-hand only, touching no allocated units, and writes a `SALE`
  movement with `referenceType: 'counter-sale'` and the terminal's transaction id — which the
  existing dedupe technique makes idempotent without a new mechanism. Reusing `commit-sale` would
  mean allocating and immediately committing the same units, writing two ledger rows for one
  instantaneous act and briefly reserving stock that is already in a shopper's hands.
- **The shelf tag stores the print event, never the price.** It records which variant, which store,
  which amount was printed, when, and by whom — so that "the tag on the shelf says 4.99" is an
  auditable fact rather than a guess. The amount is a snapshot of what the ledger said at print time;
  the ledger stays the only writer of price.
- **A planogram slot is a merchandising position, not a picking position.**
  [`bin-aisle-shelf.md`](bin-aisle-shelf.md) describes the sub-location axis for directed put-away
  and picking — where units are *found*. A planogram slot describes where a product is *shown* to a
  shopper, with facings and capacity, and it exists whether or not any units are in it. They will
  share a shelf-address vocabulary in a shop and must not share an aggregate.
- **Peripherals need a local agent, and it is a client rather than a seventh deployable.** Drivers
  for a printer or a drawer-kick line are OS-level and physically present at the store; a broker
  connection is not something to stretch across the public internet to a shop's router. The agent
  runs on the terminal, speaks to hardware locally, and speaks to the gateway over HTTPS like any
  other client. Standardising on the browser-side device APIs (WebUSB, WebHID) removes the agent for
  scanners and printers and does not remove it for everything.
- **Events** ride `ris.events` with dotted keys — `retail.counter-sale.completed`,
  `retail.cashier-session.closed`, `retail.cash-pickup.recorded`, `catalog.shelf-tag.printed` — ids
  and amounts only. A cash variance is attributable to a named person, which makes it employment-
  sensitive data: the identifier goes on the wire, the person does not
  ([ADR-037](../adr/037-consent-record-and-tombstone-erasure.md)).
- **An e-mailed receipt is a transactional notification**, rendered from data read at dispatch and
  gated by nothing, since transactional consent is on by default. A printed receipt never leaves the
  store.
- **Shared types** (the terminal view, the session view, the counter-sale command) under
  `libs/contracts/pos/`; a terminal's cached catalogue snapshot behind a `CACHE_KEYS` builder with
  its own version segment, never a key literal.
- **New permission codes**, seeded in the same change: opening a drawer, voiding a line, applying a
  manual discount, approving a variance. Restricting a cashier to *their own* store is
  [`scoped-tenant-aware-roles.md`](scoped-tenant-aware-roles.md)'s subject, and a manager override at
  the counter is [`approval-workflows.md`](approval-workflows.md)'s.

## Open design questions

- **Offline capability is the fork that decides the architecture, and it contradicts a core rail.**
  This system's no-oversell guarantee (ADR-027) rests on synchronous, version-checked writes against
  one database. A till that keeps selling with the network down cannot do that — it must sell against
  a stale local snapshot and reconcile afterwards. That is not an implementation detail to defer; it
  determines whether the terminal is a thin client of this system or a small replicated system in its
  own right. The honest observation is that a shop *physically cannot* oversell what is on its own
  shelf, so the guarantee an online channel needs is one a counter mostly provides for free — but
  "mostly" is doing real work in that sentence, and a shared-stock estate breaks it.
- **Whether the fulfillment-at-the-counter model survives contact with pick-up-in-store**, where the
  sale and the hand-over are hours apart and the existing reservation machinery genuinely applies.
  That is arguably the more interesting order type, and it is the one where the web and the shop
  floor actually meet.
- **Cash rounding.** Several currencies have no small coin, so a cash total is rounded while a card
  total is not — meaning the tender can legitimately differ from the order total. Where that
  difference is recorded (a rounding line, a ledger entry, a tolerated variance) is a decision with
  audit consequences.
- **Whether a shelf tag is a projection or an artifact.** A projection is always current and can
  never be checked against reality; an artifact records what was physically printed and lets a
  mismatch be detected — at the cost of a reprint queue that can fall behind. The legal exposure
  argues for the artifact.
- **Who the authenticated principal is at a terminal.** Today there is one subject per token. A till
  has two — the device, which is registered and trusted, and the cashier, who changes every few
  hours. Modelling both means either two credentials or a session concept richer than the current one
  ([`session-device-management.md`](session-device-management.md) proposes the storage a shared
  terminal would need).
- **How a cashier session relates to a rostered shift.** They are not the same thing — a session is a
  drawer accountability window and a shift is a labour-planning artifact, and one person can open
  three sessions in one shift. If both ever exist, the relationship needs stating rather than
  assuming; [`staff-scheduling-and-shifts.md`](staff-scheduling-and-shifts.md) owns the other half.
- **Fiscalisation.** Italy, Poland, Germany, Portugal and others require certified fiscal hardware or
  a signed, tamper-evident transaction journal, with per-country certification. It is a compliance
  surface with a legal review attached, not a feature, and it is frequently what turns a build
  decision into a buy decision.

## Effort sketch

`subsystem-scale (5+ capabilities)` — a second order-creation path, a fulfillment-at-the-counter
model, a terminal and drawer registry, the cashier-session lifecycle with an append-only cash ledger
and reconciliation, a counter-sale stock-commitment operation, a location scope axis on pricing before
shelf tags mean anything, a planogram model, and a client-side agent that is not even in this
repository. Real reuse exists and is worth naming — the `Order` aggregate, the movement ledger's
polymorphic reference, `Payment.method`'s opacity, the notification pipeline, the audit seam and
`StockLocation`'s `store` type all take this without modification. The estimate is nevertheless
optimistic, for a reason no amount of design removes: the offline question sits underneath every one
of the seven pieces, and answering it "properly" is a distributed-systems problem, not a retail one.
