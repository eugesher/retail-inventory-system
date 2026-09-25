import { ICorrelationPayload } from '../../microservices';

export interface IRetailRefundIssuePayload extends ICorrelationPayload {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  reason: string;
  actorId: string | null;
  idempotencyKey?: string;
}

export interface IRetailRefundListPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}
