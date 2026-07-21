---
title: Wishlists
cluster: Customer & Identity
effort: 1 capability
attaches_to:
  - apps/retail-microservice/src/modules/cart/domain/cart.model.ts
---

# Wishlists

## Description

A wishlist is a durable list of products a customer wants but has not bought — saved for later, shared
with family, or watched for a price drop. Every storefront has one: Shopify's saved items, Amazon's
wishlists, Vendure's favourites. The tempting one-liner is "a wishlist is a cart that never checks out",
and it is a useful starting point — but the analogy breaks in specific, load-bearing places, and naming
where it breaks is most of the design.

## Business needs

- **Save for later** — a customer researching a purchase wants to park items without committing to buy.
- **Price-drop and back-in-stock intent** — a wishlist is a durable signal ("I want this") that
  abandoned-cart-style automation and restock alerts can act on.
- **Sharing** — gift registries and family lists need a wishlist that outlives a session and can be handed
  to someone else.
- The threshold: a transactional shop where customers buy immediately never needs this; the first
  "add to wishlist" button, or the first "notify me when it's cheaper", is where a durable list has to
  exist separately from the ephemeral cart.

## Attachment points in the current core

- **The `Cart` aggregate at
  `apps/retail-microservice/src/modules/cart/domain/cart.model.ts`.** A wishlist is structurally a thin
  cart — a mutable aggregate owning lines of `variantId`, keyed to a `customerId` — so `Cart` is the shape
  to start from. **Where the analogy breaks, precisely:**
  - **`Cart` captures a price snapshot per line** (`unitPriceSnapshotMinor`, `currencySnapshot`, taken at
    add-time and never re-priced). A wishlist must do the **opposite** — it shows the *live* price, because
    the whole point of "notify me when it's cheaper" is a comparison against the current price. A wishlist
    line stores `variantId` and drops the snapshot, resolving the active price at view time.
  - **`Cart` carries checkout machinery a wishlist has no use for.** The OCC `version` exists so
    `runWithCartWriteRetry` can serialise two concurrent places; the terminal `converted` transition is a
    raw-SQL compare-and-swap in `ORDER_CART_READER` that turns two racing places into one order. A wishlist
    never converts, never reserves stock, and never places — so it needs none of the version-CAS,
    no-oversell or reservation machinery.
  - **`Cart` has an `expiresAt` TTL** — it is a disposable working set. A wishlist is **durable**; it has
    no TTL and is not swept.
  - **`Cart` fixes one `currency`** for its subtotal projection. A wishlist is currency-agnostic — a list
    of variant references priced live in whatever currency the viewer is shopping in.
- **The erasure path.** `Cart` is already **abandoned** on customer erasure (`markAbandoned()`, driven by
  the gateway's `CUSTOMER_ERASURE_WRITER` in raw SQL — ADR-037 §2), because a cart is a disposable working
  set, not a record to preserve. A wishlist is the same kind of disposable working set and drops the same
  way.

## Implementation sketch

- **Aggregate: `Wishlist`** owning `WishlistLine` children — a much thinner `Cart`: `variantId` per line,
  a `customerId`, an optional name (for multiple/shared lists), and **no money fields, no OCC-for-checkout,
  no TTL, no reservation**. It is mutable (add / remove / move-to-cart) but never terminal.
- **Move-to-cart** is the one bridge to the checkout side: it reads the wishlist line's `variantId`, then
  calls the existing cart `addLine` path, which captures the price snapshot *at that moment* — so pricing
  crosses from live-at-view to snapshotted-at-add exactly at the move, and only there.
- **Erasure** drops the customer's wishlists the way erase abandons their carts — id-keyed rows
  (`customerId` + `variantId`), so there is **no PII to null**, only rows to remove. The guide states this
  explicitly: a wishlist adds no new customer PII, so erasure has nothing to tombstone, only to delete.
- **Events** are optional and ride `ris.events` if added — `retail.wishlist.item-added` is the useful one,
  because it feeds abandoned-cart-style automation and restock alerts (a Notifications capability). Carries
  `customerId` + `variantId` only, no PII. A wishlist may equally record no events (the `Category`
  event-light precedent) if no consumer needs them.
- **Shared types** (the wishlist view) under `libs/contracts/customer/` (or `retail/` if it stays retail
  side).

## Open design questions

- **Where the wishlist lives** — retail (beside `Cart`, its structural sibling) or customer (beside the
  party it belongs to). The cart analogy pulls it retail-side; the "customer's saved things" framing pulls
  it customer-side. This is a bounded-context call, not a technical one.
- **One list or many** — a single wishlist per customer, or named lists (birthday, home, shared registry)?
  Many lists needs a `Wishlist` header per list; one list collapses to a bare line set.
- **Guest wishlists** — `Cart.customerId` is nullable for guest carts; a guest wishlist would be
  session-local and would need merging into the customer's list on login, the same merge problem a guest
  cart has.
- **Whether item-added emits an event** — only if a downstream automation consumes it; adding the event
  speculatively is a reserved surface, not a capability.

## Effort sketch

`1 capability` — a thin mutable `Wishlist` aggregate reusing the cart shape minus its entire checkout half,
plus a move-to-cart bridge. It is small **because** it is `Cart` with the hard parts (pricing snapshots,
OCC-for-checkout, reservation, TTL) removed rather than added.
