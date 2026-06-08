import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IStockLocationsListPayload, StockLocationView } from '@retail-inventory-system/contracts';

import { StockLocation } from '../../domain';
import { IStockRepositoryPort, STOCK_REPOSITORY } from '../ports';

// List Locations returns the stock locations as wire views. `activeOnly: true`
// drops deactivated locations (soft-delete is the `active` flag — ADR-027). This
// is a thin pass-through read (not cached): the location set is small and changes
// rarely, so it does not meet the caching threshold the per-variant availability
// read does.
@Injectable()
export class ListLocationsUseCase {
  constructor(
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @InjectPinoLogger(ListLocationsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockLocationsListPayload): Promise<StockLocationView[]> {
    const { activeOnly, correlationId } = payload;

    this.logger.info({ correlationId, activeOnly }, 'Received RPC: list stock locations');

    const locations = await this.repository.listLocations(activeOnly);
    return locations.map((location) => this.toView(location));
  }

  private toView(location: StockLocation): StockLocationView {
    return {
      id: location.id,
      name: location.name,
      code: location.code,
      // The enum values are strings; the wire view carries the plain string —
      // the `StockLocationTypeEnum` is an internal domain concept, not a wire
      // contract (the catalog `*StatusEnum` precedent, ADR-025).
      type: location.type,
      gln: location.gln,
      active: location.active,
    };
  }
}
