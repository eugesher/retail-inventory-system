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

// Opens a return request (RMA) for an order. The route carries **no
// `@RequiresPermission`** (that would block the owning customer, who carries no
// permissions — ADR-024). Instead this use case computes the staff override from
// `@CurrentUser().permissions` — `isStaff` is true iff the caller holds
// `order:return-authorize` — and folds `@CurrentUser().id` into `customerId` (the
// authenticated principal). The retail use case is the single enforcement point: it
// allows the open if `isStaff` OR the caller owns the order, else answers 403 (surfaced
// as `ForbiddenException` via `throwRpcError`); it also enforces the return-window +
// returnable-quantity invariants. Returns the created `ReturnRequestView` (201).
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
