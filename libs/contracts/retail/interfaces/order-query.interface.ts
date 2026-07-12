import { ICorrelationPayload } from '../../microservices';

// Wire-format command payloads for the order read + capture RPCs (ADR-028). One type, both ends:
// the gateway adapter sends it and the retail use case consumes it as its `execute(payload)`
// input, so a drift fails TypeScript on **both** sides. That is the contract test.
//
// **Authorization is split across the boundary (ADR-024 / ADR-028 §7), and that is why these
// payloads look the way they do.** A customer is never permission-gated for its own order — the
// retail use case owner-checks `order.customerId === actorId`. The *staff override* is resolved at
// the gateway and forwarded as a plain boolean (`canReadAny`, `isStaffCapture`, `isStaffCancel`),
// so retail never re-reads the permission registry. A payload that grew a permission list instead
// would move the authorization decision across the wire, which is the thing this shape exists to
// prevent.

export interface IRetailOrderGetPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

// **Own-only, with no staff override at all** — note the absence of a boolean flag here. This lists
// the caller's own orders and nothing else; there is no all-orders listing anywhere in the system,
// so `customerId` is the whole of the identity it carries.
export interface IRetailOrderListPayload extends ICorrelationPayload {
  customerId: string;
  page: number;
  pageSize: number;
}

// **`amountMinor` is not a partial-capture control.** It is accepted, but the use case rejects any
// value that is not exactly the order's `grandTotalMinor`, and `Payment.capture` takes no amount at
// all. Capture is all-or-nothing; passing a smaller number gets you an error, not a part-payment.
//
// `idempotencyKey` is optional in the type and **required in fact** (ADR-036): the use case
// fingerprints `{orderId, amountMinor}` and replays the stored `OrderView` on a same-key/same-body
// hit, `422`s a different body, and `400`s an absent key. Re-capturing an already-`captured`
// payment under a *new* key does not error — payment state is its own backstop, so it returns the
// current state.
export interface IRetailPaymentCapturePayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  isStaffCapture: boolean;
  amountMinor?: number;
  idempotencyKey?: string;
}

// A customer may cancel its **own** pending order — `isStaffCancel` widens the reach, it does not
// grant the operation. `reason` is optional and human-supplied; it is recorded on the
// `retail.order.cancelled` event and on the allocation-release movement, so it is not free text
// that disappears.
export interface IRetailOrderCancelPayload extends ICorrelationPayload {
  orderId: number;
  reason?: string;
  actorId: string;
  isStaffCancel: boolean;
}

// **Staff-only**, unlike whole-order cancel: a customer cannot cancel one line of its own order.
// Here `isStaffCancel` is not an *override* but the gate itself — the use case rejects the call
// outright when it is false (`ORDER_ACCESS_FORBIDDEN`). Same field name as on the sibling payload,
// opposite meaning: there it widens, here it admits.
//
// **Cancelling a line moves no money.** It releases the cancelled quantity's stock allocation and
// leaves every total on the order exactly as placed; a refund, if one is owed, must be raised
// separately through `retail.refund.issue`. Omit `quantity` to cancel the line's whole remaining
// unshipped amount; a value above that remainder is rejected.
export interface IRetailOrderCancelLinePayload extends ICorrelationPayload {
  orderId: number;
  orderLineId: number;
  quantity?: number;
  actorId: string;
  isStaffCancel: boolean;
}
