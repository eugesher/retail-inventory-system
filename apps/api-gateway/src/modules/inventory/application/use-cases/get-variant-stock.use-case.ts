import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { VariantStockView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IGetVariantStockQuery, IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

@Injectable()
export class GetVariantStockUseCase {
  constructor(
    @Inject(INVENTORY_GATEWAY_PORT)
    private readonly inventoryGateway: IInventoryGatewayPort,
    @InjectPinoLogger(GetVariantStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IGetVariantStockQuery,
    correlationId: string,
  ): Promise<VariantStockView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(query, 'Fetching variant stock availability');

      const stock = await this.inventoryGateway.getVariantStock(query, correlationId);

      this.logger.info(
        {
          variantId: stock.variantId,
          totalOnHand: stock.totalOnHand,
          locationCount: stock.locations.length,
        },
        'Variant stock availability fetched',
      );

      return stock;
    } catch (error) {
      this.logger.error(error, 'Error fetching variant stock availability');

      throwRpcError(error);
    }
  }
}
