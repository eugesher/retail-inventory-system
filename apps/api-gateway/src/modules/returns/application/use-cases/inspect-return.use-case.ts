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
