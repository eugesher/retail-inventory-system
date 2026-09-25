import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, OrderView, PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

@Injectable()
export class GetOrderUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(GetOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    user: ICurrentUser,
    correlationId: string,
  ): Promise<OrderView> {
    this.logger.assign({ correlationId });
    const canReadAny = user.permissions.includes(PermissionCodeEnum.ORDER_READ);

    try {
      this.logger.info({ orderId, actorId: user.id, canReadAny }, 'Fetching order');
      const order = await this.ordersGateway.getOrder(
        { orderId, actorId: user.id, canReadAny },
        correlationId,
      );
      this.logger.info({ orderId: order.id, orderNumber: order.orderNumber }, 'Order fetched');
      return order;
    } catch (error) {
      this.logger.error(error, 'Error fetching order');
      throwRpcError(error);
    }
  }
}
