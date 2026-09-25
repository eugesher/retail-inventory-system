import { Order } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

export interface IOrderPageRequest {
  page: number;
  size: number;
}

export interface IOrderPage {
  items: Order[];
  total: number;
  page: number;
  size: number;
}

export interface IOrderRepositoryPort {
  findById(id: number, scope?: ITransactionScope): Promise<Order | null>;
  findBySourceCartId(cartId: string): Promise<Order | null>;
  save(order: Order, scope?: ITransactionScope, expectedVersion?: number): Promise<Order>;
  attachAddresses(
    orderId: number,
    billingAddressId: string,
    shippingAddressId: string,
    scope?: ITransactionScope,
  ): Promise<void>;
  listByCustomer(customerId: string, page: IOrderPageRequest): Promise<IOrderPage>;
}
