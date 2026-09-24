import { Cart } from '../../domain';

export const CART_REPOSITORY = Symbol('CART_REPOSITORY');

export interface ICartRepositoryPort {
  findById(id: string): Promise<Cart | null>;
  save(cart: Cart, expectedVersion?: number): Promise<Cart>;
  reassignCustomer(cartId: string, customerId: string): Promise<void>;
}
