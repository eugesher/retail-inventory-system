import { ICorrelationPayload } from '../../microservices';

// `inventory.stock.received` — a **reserved surface** (README §2). Not dead code.
//
// `quantityDelta` is the amount received (always positive) and `newOnHand` is the running total
// **after** the commit — the two are a delta and an absolute, not two views of the same number.
// `actorId` is optional because a direct RMQ caller has no authenticated principal. `occurredAt`
// is ISO-8601.
export interface IInventoryStockReceivedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantityDelta: number;
  newOnHand: number;
  actorId?: string;
  eventVersion: 'v1';
  occurredAt: string;
}
