# Retail cart

What the retail `cart` module (`apps/retail-microservice/src/modules/cart/`) does today, beyond what
its names and types say: the `Cart` aggregate, how its writes are serialised, how it holds stock in
inventory, and how it fails. Paths below are relative to that folder unless they start at the
repository root. The rationale lives in the ADRs:
[ADR-028](../adr/028-cart-order-payment-and-address-chain.md) (the mutable cart beside the immutable
order), [ADR-030](../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) and
[ADR-038](../adr/038-reservation-ttl-sweep-and-bounded-batches.md) (the reservation hold and its
sweep), [ADR-036](../adr/036-idempotency-key-store-and-enforced-occ.md) and
[ADR-045](../adr/045-one-occ-retry-protocol.md) (OCC and its retry). Payload rules are in
[`wire-contracts.md`](wire-contracts.md#retail--cart); the code-to-status table is
`presentation/cart-rpc-exception.filter.ts`. Placing an order from a cart belongs to the `orders`
module: see [`retail-orders.md`](retail-orders.md#place-order).

## The `Cart` aggregate

- **The currency is stored in the case the caller sent.** The check is `/^[A-Za-z]{3}$/` and nothing
  uppercases the value, so a cart opened with `eur` keeps `eur` on the cart and on every line's
  snapshot (`domain/cart.model.ts`, `Cart` constructor; the gateway's `CreateCartRequestDto` uses the
  same pattern). An omitted currency comes from `RETAIL_DEFAULT_CURRENCY`.
- **`Cart.markConverted` and `Cart.markAbandoned` have no caller.** Both terminal statuses are
  written by other modules in raw SQL, because neither module may import `cart/`:
  - `converted` by Place Order, through `CartReaderTypeormAdapter.markConverted` in `orders/`. Its
    `WHERE id = ? AND status = 'active'` is the compare-and-swap that lets only one of two concurrent
    places convert the cart
    ([`retail-orders.md`](retail-orders.md#the-cart-and-customer-tables)). Setting the status through
    the aggregate would write the same value without that guard.
  - `abandoned` by customer erasure, through `CustomerErasureWriterAdapter.persistErasure`
    (`apps/api-gateway/src/modules/auth/infrastructure/persistence/customer-erasure-writer.adapter.ts`),
    for every `active` cart the customer owns.

  Both statements also run `version = version + 1`. A cart write that loaded the cart before the
  status flip therefore loses its compare-and-swap. The retry re-reads the cart and gets
  `CART_NOT_ACTIVE`.

- **`cart.expires_at` is always `NULL`.** `CreateCartUseCase` never passes `expiresAt`, and nothing
  else writes the column. The only time limit on a cart is the TTL on its inventory holds (see
  [Holding stock](#holding-stock)).

## Writes and concurrency

- **One `save` is one transaction, and the root goes first**
  (`infrastructure/persistence/cart-typeorm.repository.ts`, `CartTypeormRepository.save`). With an
  `expectedVersion`, the root write is
  `UPDATE cart … SET version = version + 1 WHERE id = ? AND version = ?`. Only after it matches a row
  does the save delete the `cart_line` rows the aggregate no longer holds and save the rest. A save
  that loses the compare-and-swap writes no lines. Without an `expectedVersion`, the save is a plain
  insert: that is the create path.
- **Every line edit moves the root version**, even though no root column changes
  (`CartTypeormRepository.persistRoot`). Two concurrent edits of different lines of one cart
  therefore conflict. Without `If-Match`, the loser retries against a fresh read, up to
  `OCC_RETRY_ATTEMPTS` attempts. With `If-Match`, the budget is one attempt.
- **A lost compare-and-swap reports the version the winner left.** After the transaction rolls back,
  `save` reads the row again through the default repository, not the rolled-back transaction. It puts
  that value into the conflict, and it reaches the caller as `details.currentVersion`.
- **Claim is a plain `UPDATE cart SET customer_id = ? WHERE id = ?`, outside the retry loop**
  (`CartTypeormRepository.reassignCustomer`, `ClaimCartUseCase.execute`).
  - TypeORM adds `version = version + 1` to it, so a cart write already in flight loses its
    compare-and-swap. This is the same `Repository.update` behaviour
    [`retail-orders.md`](retail-orders.md#reads-locks-and-versions) describes.
  - The ownership check is a separate read before the update. The update is conditioned on neither the
    previous owner nor the status, which has two consequences:
    - A claim succeeds on a `converted` or `abandoned` cart.
    - Two claims of one guest cart that run at the same time both pass the check and both succeed. The
      one that writes last owns the cart.

## Holding stock

Add Line and Change Line Quantity run the same steps, in this order, inside one retry attempt:

1. load the cart and check its owner;
2. check the `If-Match` version;
3. Add Line only: select the price;
4. reserve the line's absolute target quantity;
5. apply the change to the aggregate (`assertActive` and the quantity check are here);
6. save.

`application/use-cases/add-to-cart.use-case.ts` and `change-cart-line-quantity.use-case.ts` hold them.
The reserve comes before the aggregate check, and that decides several outcomes:

- **An edit to a cart that is no longer `active` reaches inventory before the cart refuses it.**
  - After Place, the cart's holds are `committed`. Adding more of a variant already in the cart, or
    changing one of its lines, fails with inventory's `409 RESERVATION_INVALID_STATE`, not
    `CART_NOT_ACTIVE`.
  - Adding a variant the cart does not hold creates a fresh `active` hold, and then the cart refuses
    with `CART_NOT_ACTIVE`. The hold stays until the reservation sweep expires it.
- **A direct RMQ caller that sends `quantity: 0` to Change Line Quantity gets inventory's
  `400 RESERVATION_QUANTITY_INVALID`**, because the reserve rejects `0` before
  `CART_LINE_QUANTITY_INVALID` is reached. The gateway's `@Min(1)` screens this for HTTP callers.
- **The target is absolute, so a retry is safe.** Each attempt re-reads the cart and reserves the new
  total again: the existing line quantity plus the amount added, or the requested quantity. Inventory
  sets the hold to that value and refreshes its TTL
  (`apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock.use-case.ts`,
  `ReserveStockUseCase.reserveOnce`).
- **Nothing undoes a reserve whose save failed.** A retry budget spent, a stale `If-Match` found at
  save time, or any other save error leaves the hold at the quantity the last attempt reserved:
  - after Add Line, more than the cart holds;
  - after Change Line Quantity, more or less than the cart holds.

  The next reserve of that line corrects it. So does the reservation sweep, when the hold lapses.

- **Place reconciles a hold that does not match.** When a line's hold is missing, released or
  expired, allocation takes the line's quantity directly from `available`. When the hold is `active`
  but of a different quantity, allocation releases it and does the same. Place fails only if that
  stock is gone
  (`apps/inventory-microservice/src/modules/stock/application/use-cases/allocate-stock.use-case.ts`,
  `AllocateStockUseCase.applyLineCounters`).
- **Holds carry no location.** The reserve payload has no `stockLocationId`, so inventory uses its
  default location.
- **Remove Line releases after the commit, once, and best-effort**
  (`application/use-cases/remove-from-cart.use-case.ts`, `RemoveFromCartUseCase.execute`).
  - The release selects by `cartId` + `variantId` with `reason: 'cart-removed'`. It runs outside the
    retry loop, so a retried save never releases twice.
  - A release that matches no `active` hold is a no-op in inventory.
  - A failed release is logged at `warn` and the removal still succeeds. The hold stays until the
    sweep expires it.
- **Claim makes no inventory call.** Holds are keyed on `cartId`, which a claim does not change.
- **Erasure abandons carts but releases no holds.** `CustomerErasureWriterAdapter` touches only the
  customer, address, cart and consent rows, so an erased customer's holds lapse by TTL.
- **A catalog failure during Add Line reaches the caller as a bare `500`.**
  `infrastructure/messaging/cart-catalog.rabbitmq.adapter.ts` sends `catalog.price.select` without
  `sendPreservingRpcError`, and `CartRpcExceptionFilter` catches only `CartDomainException`. The
  inventory adapter does use `sendPreservingRpcError`, so `INVENTORY_OUT_OF_STOCK` and its
  `details.available` arrive intact. The price query sends no `asOf`, so the catalog answers for
  "now".

## Events

- **The four `retail.cart.*` events go to `retail_queue` first and then to `ris.events`**
  (`infrastructure/messaging/cart-rabbitmq.publisher.ts`, `CartRabbitmqPublisher`). No handler binds
  them. Retail receives them on its own queue and discards each one with an `error` log, as
  [`retail-orders.md`](retail-orders.md#what-retail_queue-does-with-an-event) describes for the orders
  module's reserved events. They survive only as the `ris.events` copy.
- **An event is published after the commit, and a failure is only logged.** Each use case catches the
  publish error and logs it at `warn`. As in `orders/`, a failed primary emit skips the mirror, so the
  event is lost from both.
- **`occurredAt` is the moment the aggregate recorded the change**, taken from the in-memory domain
  event. For Add Line and Change Line Quantity, that is the attempt that won.

## Failure modes

| What breaks                                                         | How it shows                                                    | What recovers it                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| An Add Line or Change Line Quantity save fails after its reserve    | The hold differs from the cart line                             | The next reserve of that line, Place, or the sweep          |
| An Add Line of a new variant on a `converted` or `abandoned` cart   | `409 CART_NOT_ACTIVE`, and a fresh `active` hold is left behind | The sweep                                                   |
| A Remove Line release fails                                         | A `warn` log. The removal succeeds, and the hold stays          | The sweep                                                   |
| A catalog error during Add Line                                     | A bare `500` with no `code`                                     | The client retries                                          |
| Two claims of one guest cart at the same time                       | Both return `200`, and the later writer owns the cart           | Nothing: the claim is not conditioned on the previous owner |
| The retail process dies after a commit and before the event is sent | No `retail.cart.*` event, and no `ris.events` copy              | Nothing: there is no outbox                                 |
