// The order's own lifecycle axis — **one of three orthogonal status fields** on an
// order, evolving independently of payment and fulfillment progress (ADR-028 §2).
// It is a wire contract (not an internal domain enum like the catalog
// `ProductStatusEnum`) because it surfaces on `OrderView` and is mapped to the
// `order.status` ENUM column, so it lives in `libs/contracts` where both the
// retail microservice and the gateway read it (ADR-005).
//
// Only **three** of these five are ever assigned: `PENDING` at place-time,
// `CANCELLED` by Cancel Order, `DELIVERED` by Deliver.
//
// **`CONFIRMED` and `SHIPPED` have no producer, and they are unreachable for
// opposite reasons.** `SHIPPED` is unreachable *by design* — shipment progress lives
// on the orthogonal `OrderFulfillmentStatusEnum` axis (ADR-028 §2), so an order that
// has shipped still reads `status = PENDING` here and `fulfillmentStatus = SHIPPED`
// there. **Filtering orders by `status = 'shipped'` therefore matches nothing, ever.**
// `CONFIRMED` is unreachable because no confirmation step exists at all; both Cancel
// and Create-fulfillment *accept* it as an input state, so a value that nothing sets
// is nonetheless guarded for.
export enum OrderStatusEnum {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
}
