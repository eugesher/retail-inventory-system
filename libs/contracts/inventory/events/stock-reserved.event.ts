import { ICorrelationPayload } from '../../microservices';

// `inventory.stock.reserved` — a **reserved surface** (README §2). Not dead code.
//
// A hold, not a sale: nothing has left `quantity_on_hand`. `quantity` is the absolute held amount
// for the `(variant, location, cart)` triple, and `expiresAt` is when the hold lapses on its own —
// a consumer that caches this must treat it as expiring. `occurredAt` is ISO-8601.
export interface IInventoryStockReservedEvent extends ICorrelationPayload {
  reservationId: string;
  variantId: number;
  stockLocationId: string;
  quantity: number;
  cartId: string;
  expiresAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
