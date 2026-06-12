# The legacy order-confirm seam and stale reservation event stubs, removed

The inventory microservice no longer carries any trace of the retired
cross-service "confirm order → reserve stock" flow, nor the pre-running-totals
reservation event classes that were shaped on concepts the inventory model has
since dropped. This clears the inventory namespace so the reservation capability
that follows starts on a clean surface, with exactly one vocabulary for
"reserve stock".

## What was removed

Four things, across the inventory service and the two shared contract/messaging
libraries:

1. **The `inventory.order.confirm` RPC handler.** The inventory
   `stock.controller.ts` carried a single `@MessagePattern(...)` handler whose
   only job was to throw a typed `RpcException` — a deprecation placeholder. It
   had no live caller (see [Why now](#why-now)), so removing it changes no
   behavior; the controller now exposes **four** message handlers
   (`inventory.stock-level.get` / `.receive` / `.adjust` and
   `inventory.location.list`) instead of five.

2. **The confirm-payload contracts.** The whole
   `libs/contracts/inventory/product-stock/` subtree is gone — both the confirm
   wire payload (`IProductStockOrderConfirmPayload` /
   `IProductStockOrderConfirmItem`) and the retired `ProductStockActionEnum`
   (`manual-stock-update` / `order-product-confirm`), a lookup-classification
   enum that only carried meaning while the old append-only `product_stock`
   ledger existed. A reference sweep confirmed nothing outside that subtree
   imported any of them, and the `libs/contracts/inventory` barrel no longer
   re-exports it.

3. **The `inventory.order.confirm` routing key**, deleted from **both** mirrored
   surfaces — `ROUTING_KEYS` in `libs/messaging` and
   `MicroserviceMessagePatternEnum` in `libs/contracts/microservices` — and from
   the lock-step spec that asserts the two agree value-for-value.

4. **The old-shape reservation event stubs.** Two domain event classes,
   `StockReservedEvent` and `StockReleasedEvent`, were shaped on retired concepts
   — a `productId` aggregate id, a `storageId`, an `orderProductId` — that the
   running-totals inventory model replaced with a `variantId` / `stockLocationId`
   vocabulary. The events-publisher port declared a `publishStockReserved(...)`
   method over the old class, and the RabbitMQ publisher implemented it as an
   intentional no-op (no producer, no consumer). The two classes, their barrel
   exports, the port method, and the no-op implementation are all deleted; the
   `STOCK_EVENTS_PUBLISHER` port now carries exactly four methods
   (`publishStockLow` / `publishStockReceived` / `publishStockAdjusted` /
   `publishStockLevelInitialized`).

Fresh reserve/release events in the new `variantId` shape are rebuilt by the
reservation capability that introduces Reserve and Release — they are **not**
these classes renamed (see [Why deletion, not renaming](#why-deletion-not-renaming)).

## Why now

This seam was a deprecation placeholder reserved for exactly this moment.

- The inventory running-totals re-founding
  ([ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md))
  booted the rebuilt microservice with **only** the `inventory.order.confirm`
  deprecation stub, and stated plainly that "the whole confirm seam is removed
  when the reservation capability lands." The stub and the confirm contract were
  kept that one extra increment **only** so the retail-side caller still
  type-checked while it was being torn down.

- That retail-side teardown is already done. The checkout rebuild
  ([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)) retired the
  cross-service confirm flow — `INVENTORY_CONFIRM_GATEWAY` and
  `ConfirmOrderUseCase` were deleted, and retail no longer calls
  `inventory.order.confirm`. ADR-028 deliberately left the inventory stub and the
  `IProductStockOrderConfirmPayload` contract standing as "a reserved surface
  owned by ADR-027," to be removed when the inventory-reservation capability
  lands — that is, here. A re-verification confirmed the retail microservice
  contains no confirm remnants (no gateway port, adapter, or call site).

Building the reservation RPCs and events alongside a dead confirm RPC and a pair
of old-shape event classes would leave **two vocabularies for one concept** — a
confirm / `productId` / `storageId` lexicon beside a reserve / `variantId` /
`stockLocationId` one. Removing the dead surface first gives the new code a
single, unambiguous namespace to build in.

## Why deletion, not renaming

The replacement is a *different contract*, not a renamed one. The reservation
seam introduced next is keyed on `(cartId, variantId, stockLocationId)` against a
TTL-bounded reservation aggregate; the old confirm seam was a single
`inventory.order.confirm` RPC carrying a list of one-row-per-unit `order_product`
items. Renaming the old key, contract, or event classes to a
`legacy` / `deprecated` / `_v1` suffix would leave two of everything, and a reader
could not tell which is authoritative. The conflict-resolution rule is therefore
removal: delete the obsolete surface outright and update or delete every
reference in the same change, so the final state carries exactly one shape per
concept.

The dotted-routing-key contract and its value-for-value mirror are upheld
throughout — the key vanished from `ROUTING_KEYS` and
`MicroserviceMessagePatternEnum` together, keeping the two surfaces in agreement
([ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md)).

## Verification

- `grep -rnE 'inventory\.order\.confirm|INVENTORY_CONFIRM_GATEWAY|IProductStockOrderConfirmPayload' apps/ libs/`
  returns nothing — the acceptance grep for the dead confirm seam.
- `grep -rnE 'StockReservedEvent|StockReleasedEvent|publishStockReserved' apps/ libs/`
  returns nothing — the acceptance grep for the old-shape event stubs.
- The only surviving `product-stock` substring anywhere in the tree is the
  filename of [ADR-002](../../adr/002-redis-cache-aside-product-stock.md)
  (`002-redis-cache-aside-product-stock.md`), a legitimate documentation link —
  not code, not a contract.
- `yarn lint` (`--max-warnings 0`), `yarn build` (all five apps compile), and
  `yarn test:unit` (the routing-keys lock-step spec updated for the removed key)
  pass. `yarn test:e2e` stays green: the stub had no live caller, so the retail
  place path is unchanged — it simply performs no inventory call until the
  reservation seam is wired in later inventory work.
