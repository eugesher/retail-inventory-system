import { ICorrelationPayload } from '../../microservices';

// `retail.order.placed` — emitted onto `notification_events`, where the notification service's
// order-confirmation consumer binds it (an event goes to the queue of whoever consumes it,
// ADR-008/020). The emit is best-effort post-commit: the order is already durable, so a broker
// failure loses the notification, never the sale.
//
// **`customerEmail` is carried ON the event, resolved producer-side from the shared `customer`
// table.** That is deliberate (ADR-033): it spares the notification consumer a cross-service RPC
// per delivery. It is `null` for a tombstoned or missing customer, and `customerLocale` always
// ships `null` — nothing resolves a locale anywhere in the system.
//
// The rest of the payload is a thin header. A consumer needing line detail reads the order back.
export interface IRetailOrderPlacedEvent extends ICorrelationPayload {
  orderId: number;
  orderNumber: string;
  customerId: string | null;
  customerEmail?: string | null;
  customerLocale?: string | null;
  grandTotalMinor: number;
  currency: string;
  lineCount: number;
  eventVersion: 'v1';
  occurredAt: string;
}
