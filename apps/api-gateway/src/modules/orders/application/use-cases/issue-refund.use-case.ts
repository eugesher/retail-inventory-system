import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, IIdempotentResult, RefundView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

@Injectable()
export class IssueRefundUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(IssueRefundUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    user: ICurrentUser,
    body: { paymentId: number; amountMinor: number; reason: string; idempotencyKey: string },
    correlationId: string,
  ): Promise<IIdempotentResult<RefundView>> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        {
          orderId,
          paymentId: body.paymentId,
          amountMinor: body.amountMinor,
          actorId: user.id,
          idempotencyKey: body.idempotencyKey,
        },
        'Issuing refund',
      );
      const result = await this.ordersGateway.issueRefund(
        {
          orderId,
          paymentId: body.paymentId,
          amountMinor: body.amountMinor,
          reason: body.reason,
          actorId: user.id,
          idempotencyKey: body.idempotencyKey,
        },
        correlationId,
      );
      this.logger.info(
        { refundId: result.view.id, status: result.view.status, replayed: result.replayed },
        result.replayed ? 'Refund issue replayed from idempotency store' : 'Refund issued',
      );
      return result;
    } catch (error) {
      this.logger.error(error, 'Error issuing refund');
      throwRpcError(error);
    }
  }
}
