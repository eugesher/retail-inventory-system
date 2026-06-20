import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, RefundView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

// Issues a refund against an order's captured payment. The route is
// `@RequiresPermission('order:refund')`-gated — issuing a refund is a **staff-only**
// operation (a customer cannot refund itself), so the permission gate is the right shape
// (ADR-024). This use case folds `@CurrentUser().id` into `actorId` (the staff caller,
// recorded on the audit row); the manual endpoint always sends a real actor string (the
// system-`null` actor is reserved for the retail auto-refund-from-cancel consumer, which
// never crosses the gateway, ADR-032). The `Idempotency-Key` is forwarded (accepted +
// logged, not deduped) — the gateway-reference natural idempotency + the
// `refunded_amount_minor` ceiling are what prevent an over-refund on replay. The retail
// use case validates the captured precondition + the refundable ceiling and returns the
// `RefundView` (`status='issued'`, or `status='failed'` on a gateway decline).
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
    body: { paymentId: number; amountMinor: number; reason: string; idempotencyKey?: string },
    correlationId: string,
  ): Promise<RefundView> {
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
      const refund = await this.ordersGateway.issueRefund(
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
      this.logger.info({ refundId: refund.id, status: refund.status }, 'Refund issued');
      return refund;
    } catch (error) {
      this.logger.error(error, 'Error issuing refund');
      throwRpcError(error);
    }
  }
}
