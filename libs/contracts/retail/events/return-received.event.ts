import { ICorrelationPayload } from '../../microservices';

// `retail.return.received` — emitted onto `notification_events`, where the returns consumer binds
// it (ADR-008/020). Best-effort post-commit.
//
// The goods are **in the building, not back on the shelf**. Nothing has been inspected, nothing
// has re-entered sellable inventory, and no money has moved — that is `retail.return.inspected`
// and the refund that may follow it.
//
// `receivedAt` has **no dedicated column** on the model; it is the moment the transition ran.
//
// `customerEmail` is carried on the event, resolved producer-side from the RMA's `customerId`
// against the shared `customer` table so the consumer needs no per-delivery RPC (ADR-033). It is
// `null` for a tombstoned customer, and `customerLocale` always ships `null` — nothing in this
// system resolves a locale.
export interface IRetailReturnReceivedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  customerEmail?: string | null;
  customerLocale?: string | null;
  receivedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
