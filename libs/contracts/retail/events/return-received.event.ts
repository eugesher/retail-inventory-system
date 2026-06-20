import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.return.received` event, published after a return
// request walks `authorized → received` (warehouse `inventory:receive-return` logs the
// goods in). Framework-free (ADR-011) — the Receive use case maps the saved aggregate
// onto this interface before emitting. The past-tense counterpart of the imperative
// `retail.return.receive` command (ADR-008). Emitted onto `notification_events` (the
// consumer's own queue — the producer-targets-consumer-queue pattern, ADR-008/020), where
// the notification service binds a return-status consumer for it (a best-effort
// post-commit emit, ADR-020). `receivedAt` is the receive timestamp (the model stamps no
// dedicated column — it is the moment the transition ran). `eventVersion` is pinned to
// `'v1'`; `occurredAt` and `receivedAt` are ISO-8601 strings.
export interface IRetailReturnReceivedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  receivedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
