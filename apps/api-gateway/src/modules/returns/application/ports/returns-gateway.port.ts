import {
  ReturnDispositionEnum,
  ReturnLineConditionEnum,
  ReturnReasonCategoryEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';

export const RETURNS_GATEWAY_PORT = Symbol('RETURNS_GATEWAY_PORT');

export interface IOpenReturnCommand {
  orderId: number;
  customerId: string;
  isStaff: boolean;
  reasonCategory: ReturnReasonCategoryEnum;
  notes?: string;
  lines: { orderLineId: number; quantity: number }[];
}

export interface IAuthorizeReturnCommand {
  rmaId: number;
  actorId: string;
}

export interface IRejectReturnCommand {
  rmaId: number;
  reason?: string;
  actorId: string;
}

export interface IReceiveReturnCommand {
  rmaId: number;
  actorId: string;
}

export interface IInspectReturnCommand {
  rmaId: number;
  actorId: string;
  lines: {
    returnLineId: number;
    condition: ReturnLineConditionEnum;
    disposition: ReturnDispositionEnum;
    lineRefundAmountMinor: number;
  }[];
}

export interface ICloseReturnCommand {
  rmaId: number;
  actorId: string;
}

export interface IGetReturnQuery {
  rmaId: number;
  actorId: string;
  isStaff: boolean;
}

export interface IListOrderReturnsQuery {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}

export interface IReturnsGatewayPort {
  openReturn(command: IOpenReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  authorizeReturn(
    command: IAuthorizeReturnCommand,
    correlationId: string,
  ): Promise<ReturnRequestView>;
  rejectReturn(command: IRejectReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  receiveReturn(command: IReceiveReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  inspectReturn(command: IInspectReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  closeReturn(command: ICloseReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  getReturn(query: IGetReturnQuery, correlationId: string): Promise<ReturnRequestView>;
  listOrderReturns(
    query: IListOrderReturnsQuery,
    correlationId: string,
  ): Promise<ReturnRequestView[]>;
}
