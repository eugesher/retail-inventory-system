import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.return.closed` event, published after a return
// request walks `inspected → closed` (staff `order:return-authorize` settles the RMA).
// Closure is terminal, so it stamps the RMA's `closedAt`. Framework-free (ADR-011) — the
// Close use case maps the saved aggregate onto this interface before emitting. The
// past-tense counterpart of the imperative `retail.return.close` command (ADR-008).
// Emitted onto `retail_queue` (the producer's own queue — a reserved surface today, no
// consumer), the internal-status half of the eventing split (the later refund capability
// is the natural consumer, since a closed RMA with money owed triggers a refund).
// `closedAt` is the closure timestamp. `eventVersion` is pinned to `'v1'`; `occurredAt`
// and `closedAt` are ISO-8601 strings.
export interface IRetailReturnClosedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  closedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
