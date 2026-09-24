import { ICorrelationPayload } from '../../microservices';

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
