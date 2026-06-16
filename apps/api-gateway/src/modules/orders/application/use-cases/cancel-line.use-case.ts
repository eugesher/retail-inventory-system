import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, OrderView, PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

// Cancels one `OrderLine`'s unshipped quantity. The route is
// `@RequiresPermission('order:cancel')`-gated — line-level cancel is a **staff-only**
// operation (not owner-reachable, unlike Cancel Order), so the permission gate is the
// right shape (ADR-024). This use case still resolves `isStaffCancel` from
// `@CurrentUser().permissions` (always `true` here) and folds `@CurrentUser().id` into
// `actorId`; the retail use case enforces staff-only (a non-staff caller is 403) and
// releases the cancelled quantity's allocation proportionally with no money-total
// change. Omit `quantity` to cancel all the line's remaining unshipped quantity.
// Returns the updated `OrderView`.
@Injectable()
export class CancelLineUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(CancelLineUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    orderLineId: number,
    user: ICurrentUser,
    body: { quantity?: number },
    correlationId: string,
  ): Promise<OrderView> {
    this.logger.assign({ correlationId });
    const isStaffCancel = user.permissions.includes(PermissionCodeEnum.ORDER_CANCEL);

    try {
      this.logger.info(
        { orderId, orderLineId, actorId: user.id, isStaffCancel, quantity: body.quantity },
        'Cancelling order line',
      );
      const order = await this.ordersGateway.cancelLine(
        { orderId, orderLineId, quantity: body.quantity, actorId: user.id, isStaffCancel },
        correlationId,
      );
      this.logger.info({ orderId: order.id, orderLineId }, 'Order line cancelled');
      return order;
    } catch (error) {
      this.logger.error(error, 'Error cancelling order line');
      throwRpcError(error);
    }
  }
}
