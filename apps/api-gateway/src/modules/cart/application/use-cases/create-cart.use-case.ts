import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CART_GATEWAY_PORT, ICartCreateCommand, ICartGatewayPort } from '../ports';

@Injectable()
export class CreateCartUseCase {
  constructor(
    @Inject(CART_GATEWAY_PORT)
    private readonly cartGateway: ICartGatewayPort,
    @InjectPinoLogger(CreateCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ICartCreateCommand, correlationId: string): Promise<CartView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ customerId: command.customerId }, 'Creating cart');
      const cart = await this.cartGateway.createCart(command, correlationId);
      this.logger.info({ cartId: cart.id }, 'Cart created');
      return cart;
    } catch (error) {
      this.logger.error(error, 'Error creating cart');
      throwRpcError(error);
    }
  }
}
