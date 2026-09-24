import { ICorrelationPayload } from '../../microservices';

export interface IRetailFulfillmentCreatePayload extends ICorrelationPayload {
  orderId: number;
  stockLocationId?: string;
  lines: { orderLineId: number; quantity: number }[];
  actorId: string;
  isStaffFulfill: boolean;
}

export interface IRetailFulfillmentListPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

export interface IRetailFulfillmentShipPayload extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  trackingNumber?: string;
  carrier?: string;
  idempotencyKey?: string;
  actorId: string;
  isStaffFulfill: boolean;
}

export interface IRetailFulfillmentDeliverPayload extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  actorId: string;
  isStaffFulfill: boolean;
}
