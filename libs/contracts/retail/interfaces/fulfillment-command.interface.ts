import { ICorrelationPayload } from '../../microservices';

// Wire-format command payloads for the fulfillment RPCs (ADR-031). One type, both ends: the
// gateway adapter sends it and the retail use case consumes it as its `execute(payload)` input,
// so a drift fails TypeScript on **both** sides. That is the contract test.
//
// **Authorization is split across the boundary (ADR-024 / ADR-028 §7), and that is why these
// payloads look the way they do.** A customer is never permission-gated for its own order — the
// retail use case owner-checks `order.customerId === actorId`. The *staff override* is resolved
// at the gateway and forwarded as a plain boolean (`isStaffFulfill` for `order:fulfill`,
// `canReadAny` for `order:read`), so retail never re-reads the permission registry. A payload
// that grew a permission list instead would move the authorization decision across the wire,
// which is the thing this shape exists to prevent.

// Omitting `stockLocationId` defaults it to `INVENTORY_DEFAULT_STOCK_LOCATION`. One fulfillment
// ships from exactly one location — there is no way to express a shipment sourced from several.
export interface IRetailFulfillmentCreatePayload extends ICorrelationPayload {
  orderId: number;
  stockLocationId?: string;
  lines: { orderLineId: number; quantity: number }[];
  actorId: string;
  isStaffFulfill: boolean;
}

export interface IRetailFulfillmentListPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

// **Two fields are optional in the type and mandatory in practice — the type is the weaker
// statement here, so read this instead.**
//
// `trackingNumber` must be present to mark a fulfillment shipped (the tracking-on-ship policy,
// ADR-031). `idempotencyKey` is required and deduped (ADR-036): the use case fingerprints
// `{orderId, fulfillmentId, trackingNumber, carrier}` and, on a same-key/same-body hit, replays
// the stored `FulfillmentView` — no second capture, no second commit-sale. A same-key/different-
// body call is a `422`, an absent key a `400`. Re-shipping a non-`pending` fulfillment under a
// *new* key is still a `409`: idempotency replays a request, it does not re-open a state machine.
export interface IRetailFulfillmentShipPayload extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  trackingNumber?: string;
  carrier?: string;
  idempotencyKey?: string;
  actorId: string;
  isStaffFulfill: boolean;
}

export interface IRetailFulfillmentDeliverPayload extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  actorId: string;
  isStaffFulfill: boolean;
}
