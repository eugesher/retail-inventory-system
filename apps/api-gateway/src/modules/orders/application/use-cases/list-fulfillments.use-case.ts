import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentView,
  ICurrentUser,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

@Injectable()
export class ListFulfillmentsUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(ListFulfillmentsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    user: ICurrentUser,
    correlationId: string,
  ): Promise<FulfillmentView[]> {
    this.logger.assign({ correlationId });
    const canReadAny = user.permissions.includes(PermissionCodeEnum.ORDER_READ);

    try {
      this.logger.info({ orderId, actorId: user.id, canReadAny }, 'Listing fulfillments');
      const fulfillments = await this.ordersGateway.listFulfillments(
        { orderId, actorId: user.id, canReadAny },
        correlationId,
      );
      this.logger.info({ orderId, count: fulfillments.length }, 'Fulfillments listed');
      return fulfillments;
    } catch (error) {
      this.logger.error(error, 'Error listing fulfillments');
      throwRpcError(error);
    }
  }
}
