import { ICorrelationPayload } from '../../microservices';

export interface IRetailPaymentCapturedEvent extends ICorrelationPayload {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  eventVersion: 'v1';
  occurredAt: string;
}
