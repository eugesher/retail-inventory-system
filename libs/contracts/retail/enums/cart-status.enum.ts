// Lifecycle of a shopping cart. It is a wire contract (not an internal domain
// enum like the catalog `ProductStatusEnum`) because it surfaces on the
// `CartView` DTO and on the `retail.cart.created` event payload — so it lives in
// `libs/contracts` where both the retail microservice and the gateway can read
// it (ADR-005).
//
// `ACTIVE` is the shopper's editable working set; `CONVERTED` is the terminal
// state a cart reaches when it is placed as an order (one-shot conversion,
// ADR-028 §1); `ABANDONED` is the terminal state the later purge capability
// drives a stale cart into. There is no path back out of either terminal state.
export enum CartStatusEnum {
  ACTIVE = 'active',
  ABANDONED = 'abandoned',
  CONVERTED = 'converted',
}
