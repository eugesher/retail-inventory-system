import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IIdempotentResult, OrderView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CART_GATEWAY_PORT, ICartGatewayPort, ICartPlaceCommand } from '../ports';

// Places the cart as an order: forwards the command (with the folded `customerId` and
// the required `Idempotency-Key`) to the retail `retail.cart.place` RPC and surfaces the
// idempotency envelope `{ view, replayed }` (ADR-036). The owner-check, the one-shot
// conversion, authorize-on-place, and the fingerprint replay/`422` all happen
// retail-side; the gateway threads the verified identity, maps any RPC error onto an
// HTTP status, and hands the envelope to the controller (which sets the
// `Idempotent-Replay` header + status).
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
