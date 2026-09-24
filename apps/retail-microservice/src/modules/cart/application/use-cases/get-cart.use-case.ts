import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartGetPayload } from '@retail-inventory-system/contracts';

import { CART_REPOSITORY, ICartRepositoryPort } from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';

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
