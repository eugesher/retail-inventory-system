import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CART_GATEWAY_PORT, ICartGatewayPort, ICartGetQuery } from '../ports';

// Reads a cart by id. The owner-check is enforced retail-side from the
// `customerId` the controller folded in (`@CurrentUser().id`): a non-owner gets a
// 403, surfaced here as `ForbiddenException` via `throwRpcError`; a missing cart
// is a 404.
@Injectable()
export class GetCartUseCase {
  constructor(
    @Inject(CART_GATEWAY_PORT)
    private readonly cartGateway: ICartGatewayPort,
    @InjectPinoLogger(GetCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: ICartGetQuery, correlationId: string): Promise<CartView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ cartId: query.cartId }, 'Fetching cart');
      const cart = await this.cartGateway.getCart(query, correlationId);
      this.logger.info({ cartId: cart.id, lineCount: cart.lines.length }, 'Cart fetched');
      return cart;
    } catch (error) {
      this.logger.error(error, 'Error fetching cart');
      throwRpcError(error);
    }
  }
}
