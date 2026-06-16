import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, OrderView, PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

// Cancels a not-yet-shipped order. The route carries **no `@RequiresPermission`** —
// Cancel Order is owner-reachable (a customer may cancel its own pending order), so a
// permission gate would block the owning customer (ADR-024). This use case resolves
// the staff override `isStaffCancel` from `@CurrentUser().permissions` (true iff the
// caller holds `order:cancel`) and folds `@CurrentUser().id` into `actorId`. The
// retail use case is the single enforcement point: it allows the cancel if
// `isStaffCancel` OR the caller owns the order, then rejects a `shipped`/`delivered`
// order (409 `ORDER_NOT_CANCELLABLE`), voids/flags the payment, and releases the
// allocation. Returns the cancelled `OrderView`.
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
