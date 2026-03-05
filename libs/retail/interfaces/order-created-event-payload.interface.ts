import { OrderCreateProductDto } from '../dto';

export interface IOrderConfirmedEventPayload {
  orderId: number;
  customerId: number;
  products: OrderCreateProductDto[];
}
