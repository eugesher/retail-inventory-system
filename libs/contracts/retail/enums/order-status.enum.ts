// The order's own lifecycle axis — **one of three orthogonal status fields** on an
// order, evolving independently of payment and fulfillment progress (ADR-028 §2).
// It is a wire contract (not an internal domain enum like the catalog
// `ProductStatusEnum`) because it surfaces on `OrderView` and is mapped to the
// `order.status` ENUM column, so it lives in `libs/contracts` where both the
// retail microservice and the gateway read it (ADR-005).
//
// `PENDING` is the just-placed state; `CONFIRMED` / `SHIPPED` / `DELIVERED` are
// reached by later confirmation and fulfillment capabilities; `CANCELLED` is the
// terminal cancellation state. This foundation only ever sets `PENDING` (at
// place-time); the transitions onto the other values arrive with the operations
// that drive them.
export enum OrderStatusEnum {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
}
