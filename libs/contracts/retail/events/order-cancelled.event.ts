import { ICorrelationPayload } from '../../microservices';

// `retail.order.cancelled` — raised when an order walks `pending`/`confirmed → cancelled`.
//
// **It is emitted onto two queues under one routing key** — `retail_queue`, where retail's own
// `OrderCancelledConsumer` reads it, and `notification_events`, where the cancellation fan-out
// binds it. The publisher holds a client for each and emits twice.
//
// **`paymentFlaggedForRefund` is the signal the auto-refund path branches on.** `true` means the
// order had a **captured** payment now flagged for refund, and `OrderCancelledConsumer` issues
// that refund. `false` means nothing was captured — an authorized payment was voided, or there
// was no payment at all. A consumer that ignores the flag and refunds unconditionally refunds
// money that never moved.
//
// `customerEmail` carries the buyer's contact for the notification consumer, resolved
// producer-side from the shared `customer` table so that consumer needs no per-delivery RPC
// (ADR-033). It is `null` for a tombstoned customer, and `customerLocale` always ships `null` —
// nothing in this system resolves a locale.
export interface IRetailOrderCancelledEvent extends ICorrelationPayload {
  orderId: number;
  customerEmail?: string | null;
  customerLocale?: string | null;
  cancelledAt: string;
  reason: string | null;
  paymentFlaggedForRefund: boolean;
  eventVersion: 'v1';
  occurredAt: string;
}
