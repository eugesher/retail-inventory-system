import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IReservationReleasePayload,
  IReservationReleaseResult,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

// Thin gateway-side orchestrator over the `inventory.reservation.release` RPC,
// used here as the **manual** ops release: the controller targets one hold by
// `reservationId` and folds `reason: 'manual'` + the staff `actorId` into the
// payload. The counter return, the row flip to `released`, and the `release`
// ledger append are the inventory microservice's responsibility; the gateway
// forwards the payload (it already carries the correlation id) and maps a
// downstream rejection onto the right HTTP status via `throwRpcError` — an unknown
// id is a 404 (`INVENTORY_RESERVATION_NOT_FOUND`), an already-released/committed
// row a 409 (`INVENTORY_RESERVATION_INVALID_STATE`).
@Injectable()
export class ReleaseReservationUseCase {
  constructor(
    @Inject(INVENTORY_GATEWAY_PORT)
    private readonly inventoryGateway: IInventoryGatewayPort,
    @InjectPinoLogger(ReleaseReservationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReservationReleasePayload): Promise<IReservationReleaseResult> {
    this.logger.assign({ correlationId: payload.correlationId });

    try {
      this.logger.info(
        { reservationId: payload.reservationId, reason: payload.reason, actorId: payload.actorId },
        'Releasing reservation (manual ops release)',
      );

      const result = await this.inventoryGateway.releaseReservation(payload);

      this.logger.info(
        { reservationId: payload.reservationId, released: result.released.length },
        'Reservation released',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error releasing reservation');

      throwRpcError(error);
    }
  }
}
