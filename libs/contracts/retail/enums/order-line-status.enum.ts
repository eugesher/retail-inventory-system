// Per-line fulfillment state. A wire contract surfacing on `OrderLineView` and
// mapped to the `order_line.status` ENUM column.
//
// `ALLOCATED` is the place-time default — a **forward-compatible sentinel**: real
// allocation (reserving stock against the line) is the later inventory-reservation
// capability, so at place-time every line simply starts `ALLOCATED`. `SHIPPED` /
// `PARTIALLY_SHIPPED` / `CANCELLED` / `RETURNED` are reached by the later
// fulfillment and returns capabilities; this foundation never transitions a line
// off `ALLOCATED`.
export enum OrderLineStatusEnum {
  ALLOCATED = 'allocated',
  SHIPPED = 'shipped',
  PARTIALLY_SHIPPED = 'partially-shipped',
  CANCELLED = 'cancelled',
  RETURNED = 'returned',
}
