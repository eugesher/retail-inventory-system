import { ICorrelationPayload } from '../../microservices';
import { OrderStatusEnum } from '../enums';

export interface IOrderConfirmedEventProduct {
  orderProductId: number;
  productId: number;
}

// Wire-format shape for the `retail.order.confirmed` event published by the
// retail microservice when an order transitions to fully-confirmed. Reserved
// for future cross-service consumers; no subscriber today.
export interface IRetailOrderConfirmedEvent extends ICorrelationPayload {
  orderId: number;
  customerId: number;
  status: OrderStatusEnum;
  products: IOrderConfirmedEventProduct[];
  occurredAt: string;
}
