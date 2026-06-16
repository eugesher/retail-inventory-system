import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentView,
  ICurrentUser,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

// Marks a `shipped` fulfillment `delivered`. The route is
// `@RequiresPermission('order:fulfill')`-gated (staff-only), so `isStaffFulfill`
// resolved from `@CurrentUser().permissions` is always `true` here; the retail use
// case is the single enforcement point (ADR-024 / ADR-028 §7). Once every
// non-`cancelled` fulfillment of the order is delivered the retail side advances the
// order's lifecycle + fulfillment axes to `delivered`. Returns the delivered
// `FulfillmentView`.
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
