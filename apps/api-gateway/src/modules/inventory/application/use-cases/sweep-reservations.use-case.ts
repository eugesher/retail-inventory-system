import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IReservationSweepPayload,
  IReservationSweepResult,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

@Injectable()
export class SweepReservationsUseCase {
  constructor(
    @Inject(INVENTORY_GATEWAY_PORT)
    private readonly inventoryGateway: IInventoryGatewayPort,
    @InjectPinoLogger(SweepReservationsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReservationSweepPayload): Promise<IReservationSweepResult> {
    this.logger.assign({ correlationId: payload.correlationId });

    try {
      this.logger.info(
        { batchSize: payload.batchSize, actorId: payload.actorId },
        'Sweeping expired reservations (operator-triggered)',
      );

      const result = await this.inventoryGateway.sweepReservations(payload);

      this.logger.info(
        { scanned: result.scanned, expired: result.expired, skipped: result.skipped },
        'Reservation sweep completed',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error sweeping expired reservations');

      throwRpcError(error);
    }
  }
}
