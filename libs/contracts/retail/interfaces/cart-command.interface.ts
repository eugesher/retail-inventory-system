import { ICorrelationPayload } from '../../microservices';

export interface IRetailCartCreatePayload extends ICorrelationPayload {
  customerId: string;
  currency?: string;
}

export interface IRetailCartGetPayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
}

export interface IRetailCartAddLinePayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  variantId: number;
  quantity: number;
  expectedVersion?: number;
}

export interface IRetailCartChangeLineQuantityPayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  lineId: number;
  quantity: number;
  expectedVersion?: number;
}

export interface IRetailCartRemoveLinePayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  lineId: number;
  expectedVersion?: number;
}

export interface IRetailCartClaimPayload extends ICorrelationPayload {
  cartId: string;
  fromCustomerId: string;
  newCustomerId: string;
}
