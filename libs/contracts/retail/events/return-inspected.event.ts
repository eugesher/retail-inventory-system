import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.return.inspected` event, published after a return
// request walks `received → inspected` (warehouse `inventory:receive-return` records each
// line's condition + disposition + refund amount). Framework-free (ADR-011) — the Inspect
// & Disposition use case maps the saved aggregate onto this interface before emitting. The
// past-tense counterpart of the imperative `retail.return.inspect` command (ADR-008).
// Emitted onto `notification_events` (the consumer's own queue — the
// producer-targets-consumer-queue pattern, ADR-008/020), where the notification service
// binds a return-status consumer for it (a best-effort post-commit emit, ADR-020).
//
// `inspectedAt` is the inspection timestamp (the model stamps no dedicated column — it is
// the moment the transition ran). `restockedLineCount` is how many lines were dispositioned
// `restock` (and so flowed back to sellable inventory through
// `inventory.stock.restock-from-return`) — a downstream can tell a refund-only inspection
// (0) from one that returned goods to the shelf. `eventVersion` is pinned to `'v1'`;
// `occurredAt` and `inspectedAt` are ISO-8601 strings.
export interface IRetailReturnInspectedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  inspectedAt: string;
  restockedLineCount: number;
  eventVersion: 'v1';
  occurredAt: string;
}
