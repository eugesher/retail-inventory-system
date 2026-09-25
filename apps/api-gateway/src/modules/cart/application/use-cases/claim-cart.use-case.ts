import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CART_GATEWAY_PORT, ICartClaimCommand, ICartGatewayPort } from '../ports';

@Injectable()
export class ClaimCartUseCase {
  constructor(
    @Inject(CART_GATEWAY_PORT)
    private readonly cartGateway: ICartGatewayPort,
    @InjectPinoLogger(ClaimCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ICartClaimCommand, correlationId: string): Promise<CartView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        {
          cartId: command.cartId,
          fromCustomerId: command.fromCustomerId,
          newCustomerId: command.newCustomerId,
        },
        'Claiming guest cart',
      );
      const cart = await this.cartGateway.claim(command, correlationId);
      this.logger.info({ cartId: cart.id }, 'Guest cart claimed');
      return cart;
    } catch (error) {
      this.logger.error(error, 'Error claiming guest cart');
      throwRpcError(error);
    }
  }
}
