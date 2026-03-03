import { OrderItemDto } from '../dto';

export interface IOrderCreatedEventPayload {
  orderId: string;
  customerId: string;
  items: OrderItemDto[];
  total: number;
  createdAt: Date;
}
