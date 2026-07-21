# The physical-retail extension guide

The ninth and last cluster in [`docs/extensions/`](../../extensions/) is a single file:
[`physical-retail-pos-terminals.md`](../../extensions/physical-retail-pos-terminals.md). Every other
cluster holds six to ten guides; this one holds one, covering a surface that would be seven
aggregates. This note explains that shape, and records the one design question the guide exists to
answer — because it is the question a reader will arrive with, and the answer is not the one the
obvious framing suggests.

## 1. What the physical-retail surface is

Seven pieces, all of which appear the day a business opens a shop:

| Piece | One line |
| --- | --- |
| **POS terminal** | The registered device a sale is rung up on — its identity, its store, its configuration. |
| **Drawer / Till** | The physical cash drawer bound to a terminal, with an opening float and an expected balance. |
| **Cashier session** | The accountability window: one named person, one drawer, one count at the end. |
| **Cash pickup** | Cash removed mid-session to a safe or a deposit, so a drawer stays under its insured ceiling. |
| **Shelf tag** | The printed price on the shelf edge — in much of Europe and North America a *binding offer*. |
| **Planogram slot** | Where a product is *displayed*: fixture, shelf, facings. Merchandising, not picking. |
| **In-store peripherals** | Scanners, receipt printers, card readers, customer displays, scales, label printers. |

## 2. Why one file, not seven

Because they are not seven capabilities a reader might want one of.

The other clusters are menus in a real sense: a business can want lot tracking and not want bin
locations, or want loyalty and not want household grouping. Those guides are separable because the
decisions behind them are separable. Physical retail is not like that. Nobody adopts a cash drawer
without a till to bind it to, a cashier session with nothing to reconcile, or a shelf tag for a shop
that has no shelves. All seven are consequences of one decision — *this business also sells across a
counter* — and they become necessary on the same day.

Splitting them would have produced seven files implying seven independent choices, which is a false
picture of the decision. It would also have buried the only genuinely interesting content, which
does not belong to any single piece: whether a till sale is an `Order`. That question cuts across the
sale, the payment, the stock commitment and the return, so a file structure that separates them
separates the halves of one argument.

The cost of the single file is that it is the longest guide in the folder. That is the right trade:
length is a reading cost, and a wrong decomposition is a thinking cost.

## 3. The design question: a POS transaction versus `Order`

The tidy-sounding answer is a parallel `POSTransaction` aggregate — a till sale has no cart, settles
instantly, and ships nothing, so why force it through a model built for a delivered order? The guide
argues the opposite, and the argument comes entirely from opening the models rather than reasoning
about them.

**What a parallel aggregate costs.** Four things, each verified in source:

- `Payment` carries `orderId: number`, validated in the constructor as a positive integer. There is
  no polymorphic owner. A parallel sale needs a parallel payment record — or this model widened.
- `Refund` carries `orderId: number` for the same reason, so the refund path forks too.
- The RMA context reads its order snapshot through `RETURN_ORDER_READER`, raw SQL over `order` /
  `order_line` / `fulfillment`, and it is *forbidden* by the boundaries lint from importing the
  orders module at all ([ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md),
  [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)). A sale outside those tables
  is invisible to returns — and in-store purchases get returned constantly.
- Every reporting question a retailer actually asks — daily takings, units by variant, margin —
  becomes a union of two aggregates, permanently.

**What reusing `Order` costs.** Two things, and both are additions rather than duplications:

- `PlaceOrderUseCase` cannot be reused. It begins with a `cartId`, checks that
  `cart.customerId` equals the caller, snapshots the cart's lines, compare-and-swaps the cart to
  `converted` inside the place transaction, and uses `findBySourceCartId` as its repeat-place
  idempotency. A till has no cart in that sense. So a second creation path is needed — but it is a
  use case, not an aggregate.
- The sale would otherwise sit at `fulfillmentStatus: unfulfilled` forever, and
  `assertWithinReturnWindow` treats **every state other than `delivered` / `shipped` /
  `partially-shipped` as not returnable**. Left alone, a till sale would be permanently
  non-returnable. The fix is small and models reality: goods handed over at the counter *are*
  delivered, so the sale writes its `Fulfillment` immediately.

**The frequently-repeated objection is simply false.** "An order needs a shipping address" is not
true of this code: `Order`'s `billingAddressId` and `shippingAddressId` are both nullable, and
`PlaceOrderUseCase` passes `null` for both at construction, patching them after the address rows
exist (the rows FK onto the order — [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)
§5). `customerId` is nullable too, so a walk-in shopper is already representable. The coupling that
actually blocks reuse is the **cart**, and it lives in the use case rather than the aggregate — which
is exactly why the answer comes out the way it does.

**What the reporting layer pays either way.** With the parallel aggregate it pays continuously: every
cross-channel figure is a union, and every new report has to remember both sides. With the reused
`Order` it pays once, at the point where "orders" stops meaning "web orders" — an order row that was
never in a cart, never had an address, and was delivered at the moment it was placed. That is a
filter clause on a channel discriminator, written once. A recurring cost against a one-off one is
not a close call.

## 4. What is genuinely reused — verified, not assumed

The claim "physical retail reuses the existing location aggregate" is the kind of sentence that is
easy to repeat and worth checking. It checks out, and reading the source turned up both more reuse
than expected and one place where the expected reuse is not there:

| Seam | Verdict |
| --- | --- |
| `StockLocationTypeEnum` | **Reused as-is.** `warehouse \| store \| dropship-virtual` — `store` already exists, with a caller-assigned string PK, a `code`, an optional GLN and an `active` flag. A shop needs no new notion of place. |
| `stock_movement` reference columns | **Reused as-is.** `reference_type` / `reference_id` are nullable `VARCHAR(32)` / `VARCHAR(64)`, polymorphic and FK-less; five values are already written into them. A `counter-sale` reference type is a string, not a migration. `StockMovementTypeEnum.SALE` already carries its fixed negative sign. |
| `Payment.method` | **Reused as-is.** An opaque non-empty string retail stores and never parses, so `'cash'` widens no enum. |
| `Order` aggregate | **Reused**, with a second creation path — see §3. |
| The audit seam | **Reused**, with the shape the refund path established: `AuditTargetKind` is the closed union `staff-user \| customer \| role \| permission`, so a drawer or a session sets `targetKind: null` and carries ids in the payload. |
| The notification pipeline | **Reused as-is** for an e-mailed receipt — transactional, so consent is on by default. |
| `PAYMENT_GATEWAY` | **Two of three operations.** `capture` and `refund` key on an opaque `gatewayReference` and generalise; `authorize` takes `orderId: number` and assumes an order exists before money is asked for, which at a counter is backwards. Card-present is a different integration besides — a terminal talks to a payment *device*. |
| `inventory.stock.commit-sale` | **Not reusable.** `StockLevel.commitSale` throws a plain `Error` — an internal-bug 500 — when `quantity > quantityAllocated`, on the stated reasoning that fulfillment lines are always built from the order's own allocation. A counter sale has no reservation and no allocation, and the operation keys on a `fulfillmentId` besides. It needs a sibling operation that decrements on-hand only. |
| The `price` ledger | **Not sufficient.** Its entire scope surface is `(variantId, currency)`, enforced by the generated `open_scope_key` column, and [ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md) §2 names **location** as a deliberately deferred axis. A shelf tag is a price *for a store*, so shelf tags cannot be honest until that axis is lifted. |
| Peripherals | **No attachment point exists, and that is the finding.** All six deployables are server-side Nest applications over RabbitMQ ([ADR-018](../../adr/018-nestjs-monorepo-apps-and-libs.md)); a receipt printer sits on a shop's LAN. Peripherals need a local client at the store, not a seventh service. |

The two "not reusable" rows are the ones worth carrying forward. Both were invisible from the outside:
a reader assuming the commit-sale path is generic would design a till that 500s on its first sale, and
a reader assuming the price ledger already scopes by location would design a shelf tag that cannot
say which shop it belongs to.

## 5. The offline question, and why it is left open

The guide's `Open design questions` leads with the one that determines the architecture: a till must
keep selling when the network is down, and this system's no-oversell guarantee
([ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)) rests on synchronous,
version-checked writes against one database. Those two cannot both hold. An offline till sells
against a stale local snapshot and reconciles afterwards, which makes the terminal a small
replicated system rather than a thin client.

It is left open deliberately, because it is not a retail decision and the guide should not pretend
to settle it. The honest observation the guide does make is that a shop physically cannot oversell
what is on its own shelf — so the guarantee an online channel needs is one a counter largely provides
for free, right up until the estate shares stock across shops.

## 6. What was verified, and how

Everything above was read out of source in the change that wrote the guide. The commands, so a later
reader can re-run them rather than trust this note
([`docs/extensions/README.md` § The source of truth is the code](../../extensions/README.md)):

```bash
# the location aggregate, its type enum and its caller-assigned PK
cat apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts

# what an Order actually requires — nullable customer, nullable addresses, three status axes
sed -n '1,95p' apps/retail-microservice/src/modules/orders/domain/order.model.ts

# the real coupling: the cart, in the use case rather than the aggregate
grep -n 'cartId\|markConverted\|findBySourceCartId\|AddressId: null' \
  apps/retail-microservice/src/modules/orders/application/use-cases/place-order.use-case.ts

# Payment and Refund are bound to an order id, and it is constructor-validated
grep -n 'orderId' apps/retail-microservice/src/modules/orders/domain/payment.model.ts \
                  apps/retail-microservice/src/modules/orders/domain/refund.model.ts

# the payment seam: two opaque-reference operations, one order-shaped one
cat apps/retail-microservice/src/modules/orders/application/ports/payment-gateway.port.ts

# the allocation precondition a counter sale cannot satisfy
grep -n 'commitSale' -A 20 apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts

# the ledger's polymorphic reference columns, and the values already written into them
grep -n 'referenceType' apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-movement.entity.ts
grep -rn "referenceType: '" apps/inventory-microservice/src --include=*.ts | grep -v spec

# returns: raw SQL over the order tables, and the states it refuses
grep -n 'assertWithinReturnWindow' -A 30 \
  apps/retail-microservice/src/modules/returns/application/use-cases/open-return-request.use-case.ts

# the price ledger's single scope axis, and the axis ADR-026 deferred
grep -n 'only scope axis' -A 12 docs/adr/026-price-append-only-ledger-and-tax-category.md

# the permission registry has no physical-retail vocabulary
grep -c "= '" libs/contracts/auth/permission.enum.ts
```

## 7. Related reading

- [`docs/extensions/physical-retail-pos-terminals.md`](../../extensions/physical-retail-pos-terminals.md)
  — the guide itself.
- [`01-extension-guide-structure-and-template.md`](01-extension-guide-structure-and-template.md) —
  the template every guide follows and the argument for the six sections.
- [`11-extensions-index-readme.md`](11-extensions-index-readme.md) — the finished index and the
  checks that keep it in step with the folder.
- [ADR-055](../../adr/055-where-deliberately-unbuilt-work-is-recorded.md) — why a capability outside
  the core is recorded here rather than in the root `README.md` ledger.
- [`03-inventory-extension-guides.md`](03-inventory-extension-guides.md) — the sub-location axis a
  planogram slot must not be confused with.
