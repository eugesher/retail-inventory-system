import { ICorrelationPayload } from '../../microservices';

export interface IRetailRefundIssuedEvent extends ICorrelationPayload {
  refundId: number;
  orderId: number;
  paymentId: number;
  customerEmail?: string | null;
  customerLocale?: string | null;
  amountMinor: number;
  currency: string;
  issuedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
