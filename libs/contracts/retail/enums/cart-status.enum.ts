// Lifecycle of a shopping cart. It is a wire contract (not an internal domain
// enum like the catalog `ProductStatusEnum`) because it surfaces on the
// `CartView` DTO and on the `retail.cart.created` event payload — so it lives in
// `libs/contracts` where both the retail microservice and the gateway can read
// it (ADR-005).
//
// `ACTIVE` is the shopper's editable working set; `CONVERTED` is the terminal state a
// cart reaches when it is placed as an order (one-shot conversion, ADR-028 §1);
// `ABANDONED` is terminal too. There is no path back out of either.
//
// **Neither terminal state is driven by the `Cart` aggregate.** Place Order converts
// with raw SQL (`UPDATE cart SET status='converted' … WHERE id=? AND status='active'`),
// where the `WHERE` **is the compare-and-swap** that serialises two concurrent places —
// calling `Cart.markConverted()` instead would set the same status without it.
// `ABANDONED` has exactly one producer: **customer erasure** (ADR-037), also in raw SQL.
// **There is no stale-cart purge and no timer that abandons anything** — an abandoned
// cart in this system means an erased customer, not a forgotten shopper.
export enum CartStatusEnum {
  ACTIVE = 'active',
  ABANDONED = 'abandoned',
  CONVERTED = 'converted',
}
