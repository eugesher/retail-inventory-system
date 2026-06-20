import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, ReturnRequestView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

// Walks an `authorized` RMA → `received` (the warehouse logs the returned goods in). The
// route is `@RequiresPermission('inventory:receive-return')`-gated — a **warehouse-staff**
// operation. This use case folds `@CurrentUser().id` into `actorId`; the retail use case
// walks the status and emits `retail.return.received`. Returns the received
// `ReturnRequestView` (200).
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
