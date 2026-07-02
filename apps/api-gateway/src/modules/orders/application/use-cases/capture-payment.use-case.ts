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

// Captures the order's authorized payment. The route carries **no
// `@RequiresPermission`** (that would block the owning customer — ADR-024). This use
// case computes the staff override from `@CurrentUser().permissions` — `isStaffCapture`
// is true iff the caller holds `order:capture` — and folds `@CurrentUser().id` into
// `actorId`. The retail use case is the single enforcement point: it allows the
// capture if `isStaffCapture` OR the caller owns the order, else answers 403. The
// **required** `Idempotency-Key` (ADR-036) is forwarded and deduped retail-side; the use
// case resolves the `IIdempotentResult<OrderView>` envelope so the controller can set the
// `Idempotent-Replay: true` header on a served replay (natural payment-state idempotency
// remains the backstop).
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
