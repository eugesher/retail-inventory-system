import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, ReturnRequestView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

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
