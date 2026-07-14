import { ICorrelationPayload } from '../../microservices';

// `inventory.stock.allocated` — a **reserved surface** (README §2). Not dead code.
//
// A hold has become a firm allocation against an order (ADR-030 §4). `reservationId` is **null**
// on the direct-allocation fallback — an order can allocate stock it never held — so a consumer
// must not treat the null as a missing join.
export interface IInventoryStockAllocatedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  orderId: number;
  reservationId: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
