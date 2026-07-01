// The RPC result envelope for a request-level-idempotent retail write (place order,
// and — following this same shape — capture / ship / refund). The operation's normal
// response `view` is wrapped with a `replayed` flag so the gateway can turn a served
// replay into the `Idempotent-Replay: true` response header + a `200` status
// (docs/adr/036-idempotency-key-store-and-enforced-occ.md).
//
// It is generic over the view type because each idempotent operation returns a
// different projection (`OrderView` for place, `FulfillmentView` / `RefundView` for the
// others). Keeping the envelope generic means one wire shape and one gateway
// unwrap-and-set-header path serve every idempotent write.
export interface IIdempotentResult<TView> {
  // The operation's response projection — freshly produced on the first call, or the
  // stored response body returned verbatim on a replay.
  readonly view: TView;

  // `true` when this response was served from the idempotency store (a replay of a
  // prior identical request) rather than freshly executed. The gateway surfaces it as
  // the `Idempotent-Replay: true` response header and downgrades the status to `200`;
  // a fresh execution leaves the route's normal status (a place is `201 Created`).
  readonly replayed: boolean;
}
