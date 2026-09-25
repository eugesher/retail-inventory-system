import { ICorrelationPayload } from '../../microservices';

export interface IRetailRefundFailedEvent extends ICorrelationPayload {
  refundId: number;
  orderId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  failureReason: string;
  eventVersion: 'v1';
  occurredAt: string;
}
