import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentView,
  ICurrentUser,
  IIdempotentResult,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

// Ships a `pending` fulfillment. The route is `@RequiresPermission('order:fulfill')`-
// gated (staff-only — a customer cannot ship), so `isStaffFulfill` resolved from
// `@CurrentUser().permissions` is always `true` here; the retail use case remains the
// single enforcement point (ADR-024 / ADR-028 §7). The ship captures an authorized
// payment inline (Q5 ship-triggered capture — blocked if the gateway declines). The
// **required** `Idempotency-Key` (ADR-036) is forwarded and deduped retail-side; the use
// case resolves the `IIdempotentResult<FulfillmentView>` envelope so the controller can set
// the `Idempotent-Replay: true` header on a served replay (a non-`pending` re-ship is a 409
// backstop). The order's advanced statuses are observable via `GET /api/orders/:orderId`.
@Injectable()
export class ShipFulfillmentUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(ShipFulfillmentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    orderId: number,
    fulfillmentId: number,
    user: ICurrentUser,
    body: { trackingNumber?: string; carrier?: string; idempotencyKey: string },
    correlationId: string,
  ): Promise<IIdempotentResult<FulfillmentView>> {
    this.logger.assign({ correlationId });
    const isStaffFulfill = user.permissions.includes(PermissionCodeEnum.ORDER_FULFILL);

    try {
      this.logger.info(
        { orderId, fulfillmentId, actorId: user.id, isStaffFulfill },
        'Shipping fulfillment',
      );
      const result = await this.ordersGateway.shipFulfillment(
        {
          orderId,
          fulfillmentId,
          trackingNumber: body.trackingNumber,
          carrier: body.carrier,
          idempotencyKey: body.idempotencyKey,
          actorId: user.id,
          isStaffFulfill,
        },
        correlationId,
      );
      this.logger.info(
        {
          orderId,
          fulfillmentId: result.view.id,
          status: result.view.status,
          replayed: result.replayed,
        },
        result.replayed
          ? 'Fulfillment ship replayed from idempotency store'
          : 'Fulfillment shipped',
      );
      return result;
    } catch (error) {
      this.logger.error(error, 'Error shipping fulfillment');
      throwRpcError(error);
    }
  }
}
