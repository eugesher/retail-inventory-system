import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICurrentUser,
  PermissionCodeEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

@Injectable()
export class GetReturnUseCase {
  constructor(
    @Inject(RETURNS_GATEWAY_PORT)
    private readonly returnsGateway: IReturnsGatewayPort,
    @InjectPinoLogger(GetReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    rmaId: number,
    user: ICurrentUser,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    this.logger.assign({ correlationId });
    const isStaff = user.permissions.includes(PermissionCodeEnum.ORDER_READ);

    try {
      this.logger.info({ rmaId, actorId: user.id, isStaff }, 'Fetching return request');
      const rma = await this.returnsGateway.getReturn(
        { rmaId, actorId: user.id, isStaff },
        correlationId,
      );
      this.logger.info({ rmaId: rma.id, rmaNumber: rma.rmaNumber }, 'Return request fetched');
      return rma;
    } catch (error) {
      this.logger.error(error, 'Error fetching return request');
      throwRpcError(error);
    }
  }
}
