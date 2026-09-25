import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, PermissionCodeEnum, RefundView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

@Injectable()
export class ListRefundsUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(ListRefundsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    user: ICurrentUser,
    correlationId: string,
  ): Promise<RefundView[]> {
    this.logger.assign({ correlationId });
    const isStaff = user.permissions.includes(PermissionCodeEnum.ORDER_READ);

    try {
      this.logger.info({ orderId, actorId: user.id, isStaff }, 'Listing refunds');
      const refunds = await this.ordersGateway.listRefunds(
        { orderId, actorId: user.id, isStaff },
        correlationId,
      );
      this.logger.info({ orderId, count: refunds.length }, 'Refunds listed');
      return refunds;
    } catch (error) {
      this.logger.error(error, 'Error listing refunds');
      throwRpcError(error);
    }
  }
}
