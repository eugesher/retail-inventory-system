import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICurrentUser,
  PermissionCodeEnum,
  ReturnReasonCategoryEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IReturnsGatewayPort, RETURNS_GATEWAY_PORT } from '../ports';

@Injectable()
export class OpenReturnUseCase {
  constructor(
    @Inject(RETURNS_GATEWAY_PORT)
    private readonly returnsGateway: IReturnsGatewayPort,
    @InjectPinoLogger(OpenReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    user: ICurrentUser,
    body: {
      reasonCategory: ReturnReasonCategoryEnum;
      notes?: string;
      lines: { orderLineId: number; quantity: number }[];
    },
    correlationId: string,
  ): Promise<ReturnRequestView> {
    this.logger.assign({ correlationId });
    const isStaff = user.permissions.includes(PermissionCodeEnum.ORDER_RETURN_AUTHORIZE);

    try {
      this.logger.info(
        { orderId, customerId: user.id, isStaff, lineCount: body.lines.length },
        'Opening return request',
      );
      const rma = await this.returnsGateway.openReturn(
        {
          orderId,
          customerId: user.id,
          isStaff,
          reasonCategory: body.reasonCategory,
          notes: body.notes,
          lines: body.lines,
        },
        correlationId,
      );
      this.logger.info({ rmaId: rma.id, rmaNumber: rma.rmaNumber }, 'Return request opened');
      return rma;
    } catch (error) {
      this.logger.error(error, 'Error opening return request');
      throwRpcError(error);
    }
  }
}
