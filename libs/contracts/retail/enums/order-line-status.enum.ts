// Per-line fulfillment state. A wire contract surfacing on `OrderLineView` and
// mapped to the `order_line.status` ENUM column.
//
// `ALLOCATED` is the place-time default, and it is now literal rather than a
// sentinel: Place Order really does allocate stock against the line (ADR-031).
// Ship marks a line `SHIPPED` or `PARTIALLY_SHIPPED`; Cancel-line marks it
// `CANCELLED` once its whole quantity is cancelled.
//
// **`RETURNED` has no producer.** A return moves the RMA aggregate and restocks
// inventory (ADR-032); it never writes back to `order_line.status`. So a fully
// returned line still reads `SHIPPED` here — this axis records what was SHIPPED,
// not what was kept.
//
// A line is not "unshipped" by a cancel, either: `order_line.quantity` never
// shrinks, and the units still owed are `activeQuantity` (`quantity −
// cancelled_quantity`, ADR-040). **`status = CANCELLED` means the whole line was
// cancelled; a partially-cancelled line keeps its old status.**
export enum OrderLineStatusEnum {
  ALLOCATED = 'allocated',
  SHIPPED = 'shipped',
  PARTIALLY_SHIPPED = 'partially-shipped',
  CANCELLED = 'cancelled',
  RETURNED = 'returned',
}
