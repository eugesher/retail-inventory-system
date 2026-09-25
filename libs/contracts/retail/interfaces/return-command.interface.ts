import { ICorrelationPayload } from '../../microservices';
import { ReturnDispositionEnum, ReturnLineConditionEnum, ReturnReasonCategoryEnum } from '../enums';

export interface IRetailReturnOpenPayload extends ICorrelationPayload {
  orderId: number;
  customerId: string;
  isStaff: boolean;
  reasonCategory: ReturnReasonCategoryEnum;
  notes?: string;
  lines: { orderLineId: number; quantity: number }[];
}

export interface IRetailReturnAuthorizePayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
}

export interface IRetailReturnRejectPayload extends ICorrelationPayload {
  rmaId: number;
  reason?: string;
  actorId: string;
}

export interface IRetailReturnReceivePayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
}

export interface IRetailReturnInspectPayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
  lines: {
    returnLineId: number;
    condition: ReturnLineConditionEnum;
    disposition: ReturnDispositionEnum;
    lineRefundAmountMinor: number;
  }[];
}

export interface IRetailReturnClosePayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
}

export interface IRetailReturnGetPayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
  isStaff: boolean;
}

export interface IRetailReturnListPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}
