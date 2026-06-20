import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, ReturnRequestView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

// Walks a `requested` RMA → `rejected` (terminal). The route is
// `@RequiresPermission('order:return-authorize')`-gated — **staff-only**. This use case
// folds `@CurrentUser().id` into `actorId` and forwards the supplied `reason`, which the
// retail use case appends to the RMA's `notes` (no schema change) and rides on the
// `retail.return.rejected` event. Returns the rejected `ReturnRequestView` (200).
@Injectable()
export class RejectReturnUseCase {
  constructor(
    @Inject(RETURNS_GATEWAY_PORT)
    private readonly returnsGateway: IReturnsGatewayPort,
    @InjectPinoLogger(RejectReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    rmaId: number,
    user: ICurrentUser,
    body: { reason?: string },
    correlationId: string,
  ): Promise<ReturnRequestView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ rmaId, actorId: user.id }, 'Rejecting return request');
      const rma = await this.returnsGateway.rejectReturn(
        { rmaId, reason: body.reason, actorId: user.id },
        correlationId,
      );
      this.logger.info({ rmaId: rma.id, status: rma.status }, 'Return request rejected');
      return rma;
    } catch (error) {
      this.logger.error(error, 'Error rejecting return request');
      throwRpcError(error);
    }
  }
}
