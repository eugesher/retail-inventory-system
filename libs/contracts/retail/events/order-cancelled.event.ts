import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.order.cancelled` event. Reserved for
// future cross-service consumers; no producer today (cancel flow unimplemented).
export interface IRetailOrderCancelledEvent extends ICorrelationPayload {
  orderId: number;
  reason?: string;
  occurredAt: string;
}
