import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { StockLevelView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IAdjustStockCommand, IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

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
