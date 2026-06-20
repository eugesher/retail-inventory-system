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
// single enforcement point: a staff caller sees all of the order's RMAs, a non-staff
// caller only its own (filtered, not 403 — the own-only-list posture, so an unknown order
// resolves to an empty array rather than leaking existence).
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
