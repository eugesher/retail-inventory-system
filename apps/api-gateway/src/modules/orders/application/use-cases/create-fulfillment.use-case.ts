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
export class CreateFulfillmentUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(CreateFulfillmentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    user: ICurrentUser,
    body: { stockLocationId?: string; lines: { orderLineId: number; quantity: number }[] },
    correlationId: string,
  ): Promise<FulfillmentView> {
    this.logger.assign({ correlationId });
    const isStaffFulfill = user.permissions.includes(PermissionCodeEnum.ORDER_FULFILL);

    try {
      this.logger.info(
        { orderId, actorId: user.id, isStaffFulfill, lineCount: body.lines.length },
        'Creating fulfillment',
      );
      const fulfillment = await this.ordersGateway.createFulfillment(
        {
          orderId,
          stockLocationId: body.stockLocationId,
          lines: body.lines,
          actorId: user.id,
          isStaffFulfill,
        },
        correlationId,
      );
      this.logger.info(
        { orderId, fulfillmentId: fulfillment.id, status: fulfillment.status },
        'Fulfillment created',
      );
      return fulfillment;
    } catch (error) {
      this.logger.error(error, 'Error creating fulfillment');
      throwRpcError(error);
    }
  }
}
