import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CART_GATEWAY_PORT, ICartAddLineCommand, ICartGatewayPort } from '../ports';

// Adds a variant line to the cart. The unit price is snapshotted retail-side from
// `catalog.price.select`; an unknown/unpriced variant comes back as a 409. The
// owner-check is enforced retail-side from the folded `customerId`.
@Injectable()
export class AddToCartUseCase {
  constructor(
    @Inject(CART_GATEWAY_PORT)
    private readonly cartGateway: ICartGatewayPort,
    @InjectPinoLogger(AddToCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ICartAddLineCommand, correlationId: string): Promise<CartView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { cartId: command.cartId, variantId: command.variantId, quantity: command.quantity },
        'Adding line to cart',
      );
      const cart = await this.cartGateway.addLine(command, correlationId);
      this.logger.info({ cartId: cart.id, lineCount: cart.lines.length }, 'Line added to cart');
      return cart;
    } catch (error) {
      this.logger.error(error, 'Error adding line to cart');
      throwRpcError(error);
    }
  }
}
