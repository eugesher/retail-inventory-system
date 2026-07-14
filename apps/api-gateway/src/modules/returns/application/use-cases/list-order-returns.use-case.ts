import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICurrentUser,
  PermissionCodeEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

// Lists one order's RMAs newest-first. The route carries **no `@RequiresPermission`**
// (that would block the owning customer — ADR-024); this use case resolves the staff
// override `isStaff` from `@CurrentUser().permissions` (true iff the caller holds
// `order:read`) and folds `@CurrentUser().id` into `actorId`. The retail use case is the
// single enforcement point: staff see all of the order's RMAs, the buying customer sees the
// order's, and **anyone else gets a 403** (`RETURN_ACCESS_FORBIDDEN`) — the same refusal
// `/orders/:id/refunds` and `/orders/:id/fulfillments` give (ADR-051). A missing order is a
// 404. It used to hand a non-owner an empty list; that disagreed with every sibling.
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
