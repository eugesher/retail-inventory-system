import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { StockLocationView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IInventoryGatewayPort, IListLocationsQuery, INVENTORY_GATEWAY_PORT } from '../ports';

// Thin gateway-side orchestrator over the `inventory.location.list` RPC. The
// list is not cached on either side (a small, slow-changing set); the gateway is
// a pass-through that threads the correlation id and maps downstream errors.
@Injectable()
export class ListLocationsUseCase {
  constructor(
    @Inject(INVENTORY_GATEWAY_PORT)
    private readonly inventoryGateway: IInventoryGatewayPort,
    @InjectPinoLogger(ListLocationsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IListLocationsQuery,
    correlationId: string,
  ): Promise<StockLocationView[]> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(query, 'Listing stock locations');

      const locations = await this.inventoryGateway.listLocations(query, correlationId);

      this.logger.info({ count: locations.length }, 'Stock locations listed');

      return locations;
    } catch (error) {
      this.logger.error(error, 'Error listing stock locations');

      throwRpcError(error);
    }
  }
}
