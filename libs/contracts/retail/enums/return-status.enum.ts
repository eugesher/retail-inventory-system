// The RMA machine — goods coming *back*, where `FulfillmentStatusEnum` tracks goods going out.
// Enforced by the `ReturnRequest` aggregate, which lives in another service:
//
//   REQUESTED  → AUTHORIZED  staff approves (`order:return-authorize`)
//   REQUESTED  → REJECTED    staff refuses — terminal, stamps `closedAt`
//   AUTHORIZED → RECEIVED    the warehouse logs the goods in (`inventory:receive-return`)
//   RECEIVED   → INSPECTED   the warehouse records per-line condition + disposition
//   INSPECTED  → CLOSED      staff settles — terminal, stamps `closedAt`
//
// **`REJECTED` and `CLOSED` both stamp `closedAt`**, so that field cannot tell a refusal from a
// settlement — only the status can. Neither is a delete: `return_request` is append-only.
//
// **There is no path back.** Every transition above asserts an exact prior status, so an RMA that
// reached `INSPECTED` cannot be walked back to `RECEIVED` for a second look.
export enum ReturnStatusEnum {
  REQUESTED = 'requested',
  AUTHORIZED = 'authorized',
  REJECTED = 'rejected',
  RECEIVED = 'received',
  INSPECTED = 'inspected',
  CLOSED = 'closed',
}
