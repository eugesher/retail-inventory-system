import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { VariantStockView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IGetVariantStockQuery, IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

// Thin gateway-side orchestrator over the `inventory.stock-level.get` RPC. The
// availability projection (cache-aside, totals, per-location rows) is the
// inventory microservice's responsibility — the gateway only threads the
// correlation id and maps a downstream error onto the right HTTP status.
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
