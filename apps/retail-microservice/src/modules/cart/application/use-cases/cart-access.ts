import { Cart, CartDomainException, CartErrorCodeEnum } from '../../domain';
import { ICartRepositoryPort } from '../ports';

// Loads a cart and asserts the caller owns it — the retail-side half of the
// bearer-plus-owner-check model (ADR-028 §7). The gateway already compares
// `@CurrentUser().id` to the cart owner, but each retail read/write use case
// re-asserts it here so the service is not solely trusting the edge
// (defense-in-depth; the gateway is the only caller, but the check is cheap).
//
// A missing cart is a 404 (`CART_NOT_FOUND`); a non-owner is a 403
// (`CART_ACCESS_FORBIDDEN`) — both surface through the cart RPC exception filter.
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
