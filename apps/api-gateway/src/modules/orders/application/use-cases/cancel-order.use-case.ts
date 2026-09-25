import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, OrderView, PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

@Injectable()
export class CancelOrderUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(CancelOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    user: ICurrentUser,
    body: { reason?: string },
    correlationId: string,
  ): Promise<OrderView> {
    this.logger.assign({ correlationId });
    const isStaffCancel = user.permissions.includes(PermissionCodeEnum.ORDER_CANCEL);

    try {
      this.logger.info(
        { orderId, actorId: user.id, isStaffCancel, reason: body.reason },
        'Cancelling order',
      );
      const order = await this.ordersGateway.cancelOrder(
        { orderId, reason: body.reason, actorId: user.id, isStaffCancel },
        correlationId,
      );
      this.logger.info({ orderId: order.id, status: order.status }, 'Order cancelled');
      return order;
    } catch (error) {
      this.logger.error(error, 'Error cancelling order');
      throwRpcError(error);
    }
  }
}
