import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.order.cancelled` event published by the
// retail microservice when an order is cancelled. Reserved for future
// cross-service consumers; no producer today (the cancel flow is not yet
// implemented — see task-09 brief).
export interface IRetailOrderCancelledEvent extends ICorrelationPayload {
  orderId: number;
  customerId: number;
  reason?: string;
  occurredAt: string;
}
