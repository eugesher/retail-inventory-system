import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, ReturnRequestView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

// Walks an `inspected` RMA → `closed` (terminal — the RMA is settled). The route is
// `@RequiresPermission('order:return-authorize')`-gated — **staff-only**. This use case
// folds `@CurrentUser().id` into `actorId`; the retail use case walks the status and
// emits `retail.return.closed`. Closing does not itself issue a refund — Issue Refund is
// a distinct, explicit operation that consumes the per-line amounts recorded at Inspect.
// Returns the closed `ReturnRequestView` (200).
@Injectable()
export class CloseReturnUseCase {
  constructor(
    @Inject(RETURNS_GATEWAY_PORT)
    private readonly returnsGateway: IReturnsGatewayPort,
    @InjectPinoLogger(CloseReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    rmaId: number,
    user: ICurrentUser,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ rmaId, actorId: user.id }, 'Closing return request');
      const rma = await this.returnsGateway.closeReturn({ rmaId, actorId: user.id }, correlationId);
      this.logger.info({ rmaId: rma.id, status: rma.status }, 'Return request closed');
      return rma;
    } catch (error) {
      this.logger.error(error, 'Error closing return request');
      throwRpcError(error);
    }
  }
}
