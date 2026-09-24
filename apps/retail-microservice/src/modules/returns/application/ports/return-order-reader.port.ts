import { OrderFulfillmentStatusEnum, OrderStatusEnum } from '@retail-inventory-system/contracts';

export const RETURN_ORDER_READER = Symbol('RETURN_ORDER_READER');

export interface IReturnOrderLineSnapshot {
  orderLineId: number;
  variantId: number;
  quantity: number;
  cancelledQuantity: number;
}

export interface IReturnOrderSnapshot {
  orderId: number;
  customerId: string | null;
  status: OrderStatusEnum;
  fulfillmentStatus: OrderFulfillmentStatusEnum;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  lines: IReturnOrderLineSnapshot[];
}

export interface IReturnOrderReaderPort {
  findOrderForReturn(orderId: number): Promise<IReturnOrderSnapshot | null>;
}
