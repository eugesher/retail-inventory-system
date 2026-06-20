import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, ReturnRequestView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

// Walks a `requested` RMA → `authorized`. The route is
// `@RequiresPermission('order:return-authorize')`-gated — authorizing a return is a
// **staff-only** operation (a customer cannot authorize its own return), so the
// permission gate is the right shape (ADR-024). This use case folds `@CurrentUser().id`
// into `actorId` (the resolved caller, for audit/logging); the retail use case walks the
// status (`RETURN_NOT_FOUND` 404 / `RETURN_INVALID_STATUS_TRANSITION` 409) and emits
// `retail.return.authorized`. Returns the updated `ReturnRequestView` (200).
@Injectable()
export class AuthorizeReturnUseCase {
  constructor(
    @Inject(RETURNS_GATEWAY_PORT)
    private readonly returnsGateway: IReturnsGatewayPort,
    @InjectPinoLogger(AuthorizeReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    rmaId: number,
    user: ICurrentUser,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ rmaId, actorId: user.id }, 'Authorizing return request');
      const rma = await this.returnsGateway.authorizeReturn(
        { rmaId, actorId: user.id },
        correlationId,
      );
      this.logger.info({ rmaId: rma.id, status: rma.status }, 'Return request authorized');
      return rma;
    } catch (error) {
      this.logger.error(error, 'Error authorizing return request');
      throwRpcError(error);
    }
  }
}
