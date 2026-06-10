import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, OrderView, PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

// Reads one order by id. The route carries **no `@RequiresPermission`** (that would
// block the owning customer, who carries no permissions — ADR-024). Instead this use
// case computes the staff override from `@CurrentUser().permissions` — `canReadAny` is
// true iff the caller holds `order:read` — and folds `@CurrentUser().id` into
// `actorId`. The retail use case is the single enforcement point: it allows the read
// if `canReadAny` OR the caller owns the order, else answers 403 (surfaced here as
// `ForbiddenException` via `throwRpcError`); a missing order is a 404.
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
