import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, PermissionCodeEnum, RefundView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

// Lists an order's refunds newest-first. The route carries **no `@RequiresPermission`**
// (that would block the owning customer — ADR-024); this use case resolves the staff
// override `isStaff` from `@CurrentUser().permissions` (true iff the caller holds
// `order:read`) and folds `@CurrentUser().id` into `actorId`. The retail use case is the
// single enforcement point: it allows the list if `isStaff` OR the caller owns the order,
// else 403 (`REFUND_ACCESS_FORBIDDEN`). An order with no refunds resolves to an empty
// array.
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
