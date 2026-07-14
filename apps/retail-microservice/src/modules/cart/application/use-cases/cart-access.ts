import { Cart, CartDomainException, CartErrorCodeEnum } from '../../domain';
import { ICartRepositoryPort } from '../ports';

// **The one gate. Every cart use case that touches a cart by id comes through here.** If a new one
// does not, the module has grown a second authorization model without deciding to.
//
// It is the retail-side half of the bearer-plus-owner-check model (ADR-028 §7): a customer is
// authorized by *authentication plus ownership*, never by a permission code. The gateway has
// already compared `@CurrentUser().id` to the cart owner — and this re-asserts it anyway, because
// **the gateway is not a boundary the RPC can rely on.** A `@MessagePattern` on `retail_queue` is
// reachable by anything that can publish to that queue. The edge is a convenience, not a wall.
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
