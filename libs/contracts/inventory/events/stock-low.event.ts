import { ICorrelationPayload } from '../../microservices';

// `inventory.stock.low` — **the one inventory event with a real consumer.** The notification
// service binds it for an ops alert, so it is emitted onto `notification_events` rather than
// inventory's own queue (an event goes to the queue of whoever consumes it, ADR-008/020). Every
// other `inventory.*` event is a reserved surface.
//
// **It fires on the way DOWN, and only on the way down.** The emitter requires a negative delta
// *and* a resulting on-hand at or below the threshold. A level that is already below and simply
// stays there raises nothing; neither does a partial restock that leaves it below. **Silence is not
// evidence that stock is healthy** — it means nothing crossed the line just now.
//
// `quantity` is the post-commit `quantityOnHand`, keyed per `(variantId, stockLocationId)`
// (ADR-027).
export interface IInventoryStockLowEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  threshold: number;
  eventVersion: 'v1';
  occurredAt: string;
}
