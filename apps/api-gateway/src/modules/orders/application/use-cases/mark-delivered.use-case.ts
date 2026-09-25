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
export class MarkDeliveredUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(MarkDeliveredUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    fulfillmentId: number,
    user: ICurrentUser,
    correlationId: string,
  ): Promise<FulfillmentView> {
    this.logger.assign({ correlationId });
    const isStaffFulfill = user.permissions.includes(PermissionCodeEnum.ORDER_FULFILL);

    try {
      this.logger.info(
        { orderId, fulfillmentId, actorId: user.id, isStaffFulfill },
        'Marking fulfillment delivered',
      );
      const fulfillment = await this.ordersGateway.markDelivered(
        { orderId, fulfillmentId, actorId: user.id, isStaffFulfill },
        correlationId,
      );
      this.logger.info(
        { orderId, fulfillmentId: fulfillment.id, status: fulfillment.status },
        'Fulfillment delivered',
      );
      return fulfillment;
    } catch (error) {
      this.logger.error(error, 'Error marking fulfillment delivered');
      throwRpcError(error);
    }
  }
}
