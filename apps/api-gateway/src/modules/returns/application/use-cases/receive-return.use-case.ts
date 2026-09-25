import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, ReturnRequestView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

@Injectable()
export class ReceiveReturnUseCase {
  constructor(
    @Inject(RETURNS_GATEWAY_PORT)
    private readonly returnsGateway: IReturnsGatewayPort,
    @InjectPinoLogger(ReceiveReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    rmaId: number,
    user: ICurrentUser,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ rmaId, actorId: user.id }, 'Receiving return request');
      const rma = await this.returnsGateway.receiveReturn(
        { rmaId, actorId: user.id },
        correlationId,
      );
      this.logger.info({ rmaId: rma.id, status: rma.status }, 'Return request received');
      return rma;
    } catch (error) {
      this.logger.error(error, 'Error receiving return request');
      throwRpcError(error);
    }
  }
}
