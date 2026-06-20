import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICurrentUser,
  ReturnDispositionEnum,
  ReturnLineConditionEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

// Walks a `received` RMA → `inspected`, recording each line's condition/disposition/
// refund amount. The route is `@RequiresPermission('inventory:receive-return')`-gated —
// a **warehouse-staff** operation. This use case folds `@CurrentUser().id` into `actorId`
// (which rides the cross-service restock RPC's audit row) and forwards the per-line
// inspection outcomes verbatim. The retail use case requires the set to cover every RMA
// line (an unknown line is 404, an incomplete set 400), walks the status in one
// transaction, and — for `restock`-disposition lines — calls the inventory restock RPC
// after the commit. Returns the inspected `ReturnRequestView` (200).
@Injectable()
export class InspectReturnUseCase {
  constructor(
    @Inject(RETURNS_GATEWAY_PORT)
    private readonly returnsGateway: IReturnsGatewayPort,
    @InjectPinoLogger(InspectReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    rmaId: number,
    user: ICurrentUser,
    body: {
      lines: {
        returnLineId: number;
        condition: ReturnLineConditionEnum;
        disposition: ReturnDispositionEnum;
        lineRefundAmountMinor: number;
      }[];
    },
    correlationId: string,
  ): Promise<ReturnRequestView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { rmaId, actorId: user.id, lineCount: body.lines.length },
        'Inspecting return request',
      );
      const rma = await this.returnsGateway.inspectReturn(
        { rmaId, actorId: user.id, lines: body.lines },
        correlationId,
      );
      this.logger.info({ rmaId: rma.id, status: rma.status }, 'Return request inspected');
      return rma;
    } catch (error) {
      this.logger.error(error, 'Error inspecting return request');
      throwRpcError(error);
    }
  }
}
