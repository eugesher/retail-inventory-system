import { ICorrelationPayload } from '../../microservices';

// `retail.return.inspected` — emitted onto `notification_events`, where the returns consumer binds
// it (ADR-008/020). Best-effort post-commit.
//
// **`restockedLineCount` is the field that carries the outcome.** It counts the lines dispositioned
// `restock` — the ones that flowed back to sellable inventory through
// `inventory.stock.restock-from-return`. A `0` means the goods came back and were scrapped or
// quarantined: the buyer may still be owed money, but nothing returned to the shelf. Without this
// count a consumer cannot tell a refund-only inspection from a restocking one.
//
// `inspectedAt` has **no dedicated column** on the model — it is simply the moment the transition
// ran, stamped on the way out.
//
// `customerEmail` is carried on the event, resolved producer-side from the RMA's `customerId`
// against the shared `customer` table so the consumer needs no per-delivery RPC (ADR-033). It is
// `null` for a tombstoned customer, and `customerLocale` always ships `null` — nothing in this
// system resolves a locale.
export interface IRetailReturnInspectedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  customerEmail?: string | null;
  customerLocale?: string | null;
  inspectedAt: string;
  restockedLineCount: number;
  eventVersion: 'v1';
  occurredAt: string;
}
