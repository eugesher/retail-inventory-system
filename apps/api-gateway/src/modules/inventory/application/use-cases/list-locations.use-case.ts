import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { StockLocationView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IInventoryGatewayPort, IListLocationsQuery, INVENTORY_GATEWAY_PORT } from '../ports';

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
