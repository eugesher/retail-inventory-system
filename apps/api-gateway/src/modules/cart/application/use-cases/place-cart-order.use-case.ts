import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { OrderView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CART_GATEWAY_PORT, ICartGatewayPort, ICartPlaceCommand } from '../ports';

// Places the cart as an order: forwards the command (with the folded `customerId`
// and the accepted-not-deduped `Idempotency-Key`) to the retail `retail.cart.place`
// RPC and surfaces the resulting `OrderView`. The owner-check + the one-shot
// conversion + authorize-on-place all happen retail-side; the gateway just threads
// the verified identity and maps any RPC error onto an HTTP status.
@Injectable()
export class PlaceCartOrderUseCase {
  constructor(
    @Inject(CART_GATEWAY_PORT)
    private readonly cartGateway: ICartGatewayPort,
    @InjectPinoLogger(PlaceCartOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ICartPlaceCommand, correlationId: string): Promise<OrderView> {
    this.logger.assign({ correlationId });

    try {
      // The `Idempotency-Key` is logged here (and forwarded on the RPC) but not
      // deduped — repeat-place safety comes from cart state (Q10 / ADR-028 §6).
      this.logger.info(
        { cartId: command.cartId, idempotencyKey: command.idempotencyKey },
        'Placing order from cart',
      );
      const order = await this.cartGateway.placeOrder(command, correlationId);
      this.logger.info(
        { cartId: command.cartId, orderId: order.id, orderNumber: order.orderNumber },
        'Order placed',
      );
      return order;
    } catch (error) {
      this.logger.error(error, 'Error placing order from cart');
      throwRpcError(error);
    }
  }
}
