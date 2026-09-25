import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICurrentUser,
  PermissionCodeEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

@Injectable()
export class ListOrderReturnsUseCase {
  constructor(
    @Inject(RETURNS_GATEWAY_PORT)
    private readonly returnsGateway: IReturnsGatewayPort,
    @InjectPinoLogger(ListOrderReturnsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    user: ICurrentUser,
    correlationId: string,
  ): Promise<ReturnRequestView[]> {
    this.logger.assign({ correlationId });
    const isStaff = user.permissions.includes(PermissionCodeEnum.ORDER_READ);

    try {
      this.logger.info({ orderId, actorId: user.id, isStaff }, 'Listing order return requests');
      const rmas = await this.returnsGateway.listOrderReturns(
        { orderId, actorId: user.id, isStaff },
        correlationId,
      );
      this.logger.info({ orderId, count: rmas.length }, 'Order return requests listed');
      return rmas;
    } catch (error) {
      this.logger.error(error, 'Error listing order return requests');
      throwRpcError(error);
    }
  }
}
