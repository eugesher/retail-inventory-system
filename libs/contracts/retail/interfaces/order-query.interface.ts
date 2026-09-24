import { ICorrelationPayload } from '../../microservices';

export interface IRetailOrderGetPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

export interface IRetailOrderListPayload extends ICorrelationPayload {
  customerId: string;
  page: number;
  pageSize: number;
}

export interface IRetailPaymentCapturePayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  isStaffCapture: boolean;
  amountMinor?: number;
  idempotencyKey?: string;
}

export interface IRetailOrderCancelPayload extends ICorrelationPayload {
  orderId: number;
  reason?: string;
  actorId: string;
  isStaffCancel: boolean;
}

export interface IRetailOrderCancelLinePayload extends ICorrelationPayload {
  orderId: number;
  orderLineId: number;
  quantity?: number;
  actorId: string;
  isStaffCancel: boolean;
}
