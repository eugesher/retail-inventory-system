import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CART_GATEWAY_PORT, ICartChangeLineQuantityCommand, ICartGatewayPort } from '../ports';

@Injectable()
export class ChangeCartLineQuantityUseCase {
  constructor(
    @Inject(CART_GATEWAY_PORT)
    private readonly cartGateway: ICartGatewayPort,
    @InjectPinoLogger(ChangeCartLineQuantityUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: ICartChangeLineQuantityCommand,
    correlationId: string,
  ): Promise<CartView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { cartId: command.cartId, lineId: command.lineId, quantity: command.quantity },
        'Changing cart line quantity',
      );
      const cart = await this.cartGateway.changeLineQuantity(command, correlationId);
      this.logger.info({ cartId: cart.id }, 'Cart line quantity changed');
      return cart;
    } catch (error) {
      this.logger.error(error, 'Error changing cart line quantity');
      throwRpcError(error);
    }
  }
}
