import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IReservationSweepPayload,
  IReservationSweepResult,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

// Thin gateway-side orchestrator over the `inventory.reservation.sweep` RPC — the
// on-demand twin of the inventory service's sweep timer. The controller folds the
// staff `actorId` into the payload (ADR-028); every `release` ledger row the sweep
// writes then names the human who pressed the button, which is the only behavioural
// difference from an unattended tick.
//
// The scan, the expiry, the counter return, the ledger appends, and the per-hold
// `inventory.stock.released` emissions are the inventory microservice's business
// (ADR-038); the gateway forwards the payload (it already carries the correlation id)
// and maps a downstream rejection onto the right HTTP status via `throwRpcError` — an
// exhausted optimistic-retry budget is a 409 (`INVENTORY_STOCK_WRITE_CONFLICT`).
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
