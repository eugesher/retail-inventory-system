import { Cart, CartDomainException, CartErrorCodeEnum } from '../../domain';
import { ICartRepositoryPort } from '../ports';

export async function loadOwnedCart(
  repository: ICartRepositoryPort,
  cartId: string,
  customerId: string,
): Promise<Cart> {
  const cart = await repository.findById(cartId);
  if (cart === null) {
    throw new CartDomainException(CartErrorCodeEnum.CART_NOT_FOUND, `Cart ${cartId} was not found`);
  }
  if (cart.customerId !== customerId) {
    throw new CartDomainException(
      CartErrorCodeEnum.CART_ACCESS_FORBIDDEN,
      `Cart ${cartId} is not owned by the caller`,
    );
  }
  return cart;
}
