import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.return.authorized` event, published after a return
// request walks `requested → authorized` (staff `order:return-authorize`). Framework-free
// (ADR-011) — the Authorize use case maps the saved aggregate onto this interface before
// emitting. The past-tense counterpart of the imperative `retail.return.authorize`
// command (ADR-008). Emitted onto `notification_events` (the consumer's own queue — the
// producer-targets-consumer-queue pattern, ADR-008/020), where the notification service
// binds a return-status consumer for it (a best-effort post-commit emit, ADR-020).
// `rmaId` / `rmaNumber` / `orderId` / `customerId` are the RMA identity; `authorizedAt` is
// the authorization timestamp. `eventVersion` is pinned to `'v1'`; `occurredAt` and
// `authorizedAt` are ISO-8601 strings.
//
// `customerEmail` / `customerLocale` carry the buyer's notification contact, resolved
// producer-side from the RMA's `customerId` against the shared `customer` table (a raw-SQL
// reader, no gateway-entity import) so the returns consumer has a recipient WITHOUT a
// per-delivery cross-service RPC (ADR-033 choice). The email is `null` for a
// tombstoned/missing customer; `customerLocale` is a placeholder shipped `null` today
// (locale deferred). Both optional — additive on the wire.
export interface IRetailReturnAuthorizedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  customerEmail?: string | null;
  customerLocale?: string | null;
  authorizedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
