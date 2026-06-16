import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentView,
  ICurrentUser,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

// Ships a `pending` fulfillment. The route is `@RequiresPermission('order:fulfill')`-
// gated (staff-only — a customer cannot ship), so `isStaffFulfill` resolved from
// `@CurrentUser().permissions` is always `true` here; the retail use case remains the
// single enforcement point (ADR-024 / ADR-028 §7). The ship captures an authorized
// payment inline (Q5 ship-triggered capture — blocked if the gateway declines). The
// `Idempotency-Key` is forwarded (accepted + logged, not deduped — the cart-state
// analogue; a non-`pending` re-ship is a 409). Returns the shipped `FulfillmentView`
// (the order's advanced statuses are observable via `GET /api/orders/:orderId`).
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
    body: { trackingNumber?: string; carrier?: string; idempotencyKey?: string },
    correlationId: string,
  ): Promise<FulfillmentView> {
    this.logger.assign({ correlationId });
    const isStaffFulfill = user.permissions.includes(PermissionCodeEnum.ORDER_FULFILL);

    try {
      this.logger.info(
        { orderId, fulfillmentId, actorId: user.id, isStaffFulfill },
        'Shipping fulfillment',
      );
      const fulfillment = await this.ordersGateway.shipFulfillment(
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
        { orderId, fulfillmentId: fulfillment.id, status: fulfillment.status },
        'Fulfillment shipped',
      );
      return fulfillment;
    } catch (error) {
      this.logger.error(error, 'Error shipping fulfillment');
      throwRpcError(error);
    }
  }
}
