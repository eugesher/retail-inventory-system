import {
  FulfillmentView,
  IIdempotentResult,
  IPage,
  OrderView,
  RefundView,
} from '@retail-inventory-system/contracts';

export const ORDERS_GATEWAY_PORT = Symbol('ORDERS_GATEWAY_PORT');

export interface IOrderGetQuery {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

export interface IOrderListQuery {
  customerId: string;
  page: number;
  pageSize: number;
}

export interface IPaymentCaptureCommand {
  orderId: number;
  actorId: string;
  isStaffCapture: boolean;
  amountMinor?: number;
  idempotencyKey?: string;
}

export interface IFulfillmentCreateCommand {
  orderId: number;
  stockLocationId?: string;
  lines: { orderLineId: number; quantity: number }[];
  actorId: string;
  isStaffFulfill: boolean;
}

export interface IFulfillmentShipCommand {
  orderId: number;
  fulfillmentId: number;
  trackingNumber?: string;
  carrier?: string;
  idempotencyKey?: string;
  actorId: string;
  isStaffFulfill: boolean;
}

export interface IFulfillmentDeliverCommand {
  orderId: number;
  fulfillmentId: number;
  actorId: string;
  isStaffFulfill: boolean;
}

export interface IFulfillmentListQuery {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

export interface IOrderCancelCommand {
  orderId: number;
  reason?: string;
  actorId: string;
  isStaffCancel: boolean;
}

export interface IOrderLineCancelCommand {
  orderId: number;
  orderLineId: number;
  quantity?: number;
  actorId: string;
  isStaffCancel: boolean;
}

export interface IRefundIssueCommand {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  reason: string;
  actorId: string;
  idempotencyKey?: string;
}

export interface IRefundListQuery {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}

export interface IOrdersGatewayPort {
  getOrder(query: IOrderGetQuery, correlationId: string): Promise<OrderView>;
  listMyOrders(query: IOrderListQuery, correlationId: string): Promise<IPage<OrderView>>;
  capturePayment(
    command: IPaymentCaptureCommand,
    correlationId: string,
  ): Promise<IIdempotentResult<OrderView>>;
  createFulfillment(
    command: IFulfillmentCreateCommand,
    correlationId: string,
  ): Promise<FulfillmentView>;
  shipFulfillment(
    command: IFulfillmentShipCommand,
    correlationId: string,
  ): Promise<IIdempotentResult<FulfillmentView>>;
  markDelivered(
    command: IFulfillmentDeliverCommand,
    correlationId: string,
  ): Promise<FulfillmentView>;
  listFulfillments(query: IFulfillmentListQuery, correlationId: string): Promise<FulfillmentView[]>;
  cancelOrder(command: IOrderCancelCommand, correlationId: string): Promise<OrderView>;
  cancelLine(command: IOrderLineCancelCommand, correlationId: string): Promise<OrderView>;
  issueRefund(
    command: IRefundIssueCommand,
    correlationId: string,
  ): Promise<IIdempotentResult<RefundView>>;
  listRefunds(query: IRefundListQuery, correlationId: string): Promise<RefundView[]>;
}
