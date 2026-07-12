import { ICorrelationPayload } from '../../microservices';

// `inventory.stock.committed` — a **reserved surface** (README §2). Not dead code.
//
// **The only event on which stock physically leaves.** A commit decrements `quantity_on_hand`
// *and* `quantity_allocated` together (ADR-031) — every earlier event in the reserve → allocate
// chain moved counters around without shipping anything.
//
// `fulfillmentId` is the idempotency anchor: replaying a commit for the same shipment is a no-op.
export interface IInventoryStockCommittedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  orderId: number;
  fulfillmentId: string;
  eventVersion: 'v1';
  occurredAt: string;
}
