import { ICorrelationPayload } from '../../microservices';

// `retail.fulfillment.created` — a **reserved surface** (README §2). Not dead code.
//
// A shipment has been **planned**, not shipped: nothing has left the warehouse and no stock has
// been committed when this fires. The payload is a thin header — a consumer that needs more than
// `lineQuantities` reads the fulfillment back rather than expecting it here. `occurredAt` is
// ISO-8601.
export interface IRetailFulfillmentCreatedEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  stockLocationId: string;
  lineQuantities: { orderLineId: number; quantity: number }[];
  eventVersion: 'v1';
  occurredAt: string;
}
