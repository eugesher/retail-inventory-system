import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CART_GATEWAY_PORT, ICartGatewayPort, ICartRemoveLineCommand } from '../ports';

// Removes a line from the cart. An unknown line id is a 404. The owner-check is
// enforced retail-side from the folded `customerId`.
@Injectable()
export class RemoveFromCartUseCase {
  constructor(
    @Inject(CART_GATEWAY_PORT)
    private readonly cartGateway: ICartGatewayPort,
    @InjectPinoLogger(RemoveFromCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ICartRemoveLineCommand, correlationId: string): Promise<CartView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { cartId: command.cartId, lineId: command.lineId },
        'Removing line from cart',
      );
      const cart = await this.cartGateway.removeLine(command, correlationId);
      this.logger.info({ cartId: cart.id, lineCount: cart.lines.length }, 'Line removed from cart');
      return cart;
    } catch (error) {
      this.logger.error(error, 'Error removing line from cart');
      throwRpcError(error);
    }
  }
}
