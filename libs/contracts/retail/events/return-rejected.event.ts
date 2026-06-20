import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.return.rejected` event, published after a return
// request walks `requested → rejected` (staff `order:return-authorize`). Rejection is
// terminal, so it stamps the RMA's `closedAt`. Framework-free (ADR-011) — the Reject use
// case maps the saved aggregate onto this interface before emitting. The past-tense
// counterpart of the imperative `retail.return.reject` command (ADR-008). Emitted onto
// `retail_queue` (the producer's own queue — a reserved surface today, no consumer), the
// internal-status half of the eventing split (the buyer-facing requested/authorized/
// received events go to `notification_events`). `closedAt` is the rejection timestamp;
// `reason` is the optional human-supplied rejection reason. `eventVersion` is pinned to
// `'v1'`; `occurredAt` and `closedAt` are ISO-8601 strings.
export interface IRetailReturnRejectedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  closedAt: string;
  reason: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
