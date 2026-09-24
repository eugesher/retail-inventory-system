import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IStockLocationsListPayload, StockLocationView } from '@retail-inventory-system/contracts';

import { IStockRepositoryPort, STOCK_REPOSITORY } from '../ports';
import { toStockLocationView } from './stock-view.factory';

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
    return locations.map((location) => toStockLocationView(location));
  }
}
