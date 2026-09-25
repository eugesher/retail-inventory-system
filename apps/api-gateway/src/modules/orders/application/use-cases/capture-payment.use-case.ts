import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICurrentUser,
  IIdempotentResult,
  OrderView,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

@Injectable()
export class CapturePaymentUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(CapturePaymentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    user: ICurrentUser,
    options: { amountMinor?: number; idempotencyKey: string },
    correlationId: string,
  ): Promise<IIdempotentResult<OrderView>> {
    this.logger.assign({ correlationId });
    const isStaffCapture = user.permissions.includes(PermissionCodeEnum.ORDER_CAPTURE);

    try {
      this.logger.info(
        { orderId, actorId: user.id, isStaffCapture, idempotencyKey: options.idempotencyKey },
        'Capturing payment',
      );
      const result = await this.ordersGateway.capturePayment(
        {
          orderId,
          actorId: user.id,
          isStaffCapture,
          amountMinor: options.amountMinor,
          idempotencyKey: options.idempotencyKey,
        },
        correlationId,
      );
      this.logger.info(
        {
          orderId: result.view.id,
          paymentStatus: result.view.paymentStatus,
          replayed: result.replayed,
        },
        result.replayed ? 'Payment capture replayed from idempotency store' : 'Payment captured',
      );
      return result;
    } catch (error) {
      this.logger.error(error, 'Error capturing payment');
      throwRpcError(error);
    }
  }
}
