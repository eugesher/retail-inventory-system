import { ICorrelationPayload } from '../../microservices';

// `retail.return.authorized` — emitted onto `notification_events`, where the returns consumer binds
// it (ADR-008/020). Best-effort post-commit.
//
// Authorization is a **promise, not a receipt**: the goods have not arrived and nothing has been
// refunded. A consumer telling the buyer "your return is approved" is telling the truth; one
// telling them "we have your item" is not.
//
// `customerEmail` is carried on the event, resolved producer-side from the RMA's `customerId`
// against the shared `customer` table so the consumer needs no per-delivery RPC (ADR-033). It is
// `null` for a tombstoned customer, and `customerLocale` always ships `null` — nothing in this
// system resolves a locale.
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
