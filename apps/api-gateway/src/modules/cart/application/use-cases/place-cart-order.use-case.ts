import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IIdempotentResult, OrderView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CART_GATEWAY_PORT, ICartGatewayPort, ICartPlaceCommand } from '../ports';

@Injectable()
export class PlaceCartOrderUseCase {
  constructor(
    @Inject(CART_GATEWAY_PORT)
    private readonly cartGateway: ICartGatewayPort,
    @InjectPinoLogger(PlaceCartOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: ICartPlaceCommand,
    correlationId: string,
  ): Promise<IIdempotentResult<OrderView>> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { cartId: command.cartId, idempotencyKey: command.idempotencyKey },
        'Placing order from cart',
      );
      const result = await this.cartGateway.placeOrder(command, correlationId);
      this.logger.info(
        {
          cartId: command.cartId,
          orderId: result.view.id,
          orderNumber: result.view.orderNumber,
          replayed: result.replayed,
        },
        result.replayed ? 'Order place replayed from idempotency store' : 'Order placed',
      );
      return result;
    } catch (error) {
      this.logger.error(error, 'Error placing order from cart');
      throwRpcError(error);
    }
  }
}
