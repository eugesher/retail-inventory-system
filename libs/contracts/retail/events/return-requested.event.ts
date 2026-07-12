import { ICorrelationPayload } from '../../microservices';

// `retail.return.requested` — emitted onto `notification_events`, where the notification service's
// return-acknowledgement consumer binds it (an event goes to the queue of whoever consumes it,
// ADR-008/020). Best-effort post-commit: the RMA is already durable.
//
// **`customerEmail` is carried ON the event, resolved producer-side from the shared `customer`
// table.** That is deliberate (ADR-033): it spares the consumer a cross-service RPC per delivery.
// It is `null` for a tombstoned customer, and `customerLocale` always ships `null` — nothing in
// this system resolves a locale.
//
// `rmaNumber` is the human-facing `RMA-<year>-<pad8(id)>` string, finalized only once the row has
// an id — it cannot be predicted before the insert.
export interface IRetailReturnRequestedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  customerEmail?: string | null;
  customerLocale?: string | null;
  requestedAt: string;
  lineCount: number;
  eventVersion: 'v1';
  occurredAt: string;
}
