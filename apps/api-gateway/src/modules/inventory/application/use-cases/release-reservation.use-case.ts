import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IReservationReleasePayload,
  IReservationReleaseResult,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

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
