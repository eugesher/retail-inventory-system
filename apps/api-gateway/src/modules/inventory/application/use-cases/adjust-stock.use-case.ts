import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { StockLevelView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IAdjustStockCommand, IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

// Thin gateway-side orchestrator over the `inventory.stock-level.adjust` RPC. The
// signed-delta mutation, the below-zero rejection, cache invalidation, and the
// adjusted/low-stock events are the inventory microservice's responsibility — the
// gateway threads the correlation id and maps a downstream error onto the right
// HTTP status (a below-zero adjustment surfaces as a 409 via `throwRpcError`).
@Injectable()
export class AdjustStockUseCase {
  constructor(
    @Inject(INVENTORY_GATEWAY_PORT)
    private readonly inventoryGateway: IInventoryGatewayPort,
    @InjectPinoLogger(AdjustStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: IAdjustStockCommand,
    correlationId: string,
  ): Promise<StockLevelView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(command, 'Adjusting stock');

      const level = await this.inventoryGateway.adjustStock(command, correlationId);

      this.logger.info(
        { variantId: command.variantId, newOnHand: level.quantityOnHand },
        'Stock adjusted',
      );

      return level;
    } catch (error) {
      this.logger.error(error, 'Error adjusting stock');

      throwRpcError(error);
    }
  }
}
