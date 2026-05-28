import { ICorrelationPayload } from '../../microservices';
import { OrderStatusEnum } from '../enums';

export interface IOrderCreatedEventProduct {
  productId: number;
  quantity: number;
}

// Wire-format shape for the `retail.order.created` event published by the
// retail microservice after a successful order creation. Framework-free —
// consumers (today: notification-microservice) depend on the interface only.
export interface IRetailOrderCreatedEvent extends ICorrelationPayload {
  orderId: number;
  status: OrderStatusEnum;
  products: IOrderCreatedEventProduct[];
  occurredAt: string;
}
