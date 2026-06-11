import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartGetPayload } from '@retail-inventory-system/contracts';

import { CART_REPOSITORY, ICartRepositoryPort } from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';

// Reads a cart by id, owner-checked. A missing cart is a 404 and a non-owner is a
// 403 (both raised by `loadOwnedCart`). The gateway has already compared the
// bearer subject to the cart owner; this retail-side assertion is the
// defense-in-depth half (ADR-028 §7).
@Injectable()
export class GetCartUseCase {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repository: ICartRepositoryPort,
    @InjectPinoLogger(GetCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartGetPayload): Promise<CartView> {
    const { cartId, customerId, correlationId } = payload;

    this.logger.info({ correlationId, cartId }, 'Fetching cart');

    const cart = await loadOwnedCart(this.repository, cartId, customerId);

    this.logger.info({ correlationId, cartId, lineCount: cart.lines.length }, 'Cart fetched');
    return toCartView(cart);
  }
}
