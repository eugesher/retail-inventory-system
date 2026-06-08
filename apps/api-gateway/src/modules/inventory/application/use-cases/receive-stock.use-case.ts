import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { StockLevelView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IInventoryGatewayPort, INVENTORY_GATEWAY_PORT, IReceiveStockCommand } from '../ports';

// Thin gateway-side orchestrator over the `inventory.stock-level.receive` RPC.
// The running-total mutation, cache invalidation, and event emission are the
// inventory microservice's responsibility — the gateway only threads the
// correlation id and maps a downstream error onto the right HTTP status.
@Injectable()
export class ReceiveStockUseCase {
  constructor(
    @Inject(INVENTORY_GATEWAY_PORT)
    private readonly inventoryGateway: IInventoryGatewayPort,
    @InjectPinoLogger(ReceiveStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: IReceiveStockCommand,
    correlationId: string,
  ): Promise<StockLevelView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(command, 'Receiving stock');

      const level = await this.inventoryGateway.receiveStock(command, correlationId);

      this.logger.info(
        { variantId: command.variantId, newOnHand: level.quantityOnHand },
        'Stock received',
      );

      return level;
    } catch (error) {
      this.logger.error(error, 'Error receiving stock');

      throwRpcError(error);
    }
  }
}
