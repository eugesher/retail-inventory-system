import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IStockTransferResult } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IInventoryGatewayPort, INVENTORY_GATEWAY_PORT, ITransferStockCommand } from '../ports';

@Injectable()
export class TransferStockUseCase {
  constructor(
    @Inject(INVENTORY_GATEWAY_PORT)
    private readonly inventoryGateway: IInventoryGatewayPort,
    @InjectPinoLogger(TransferStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: ITransferStockCommand,
    correlationId: string,
  ): Promise<IStockTransferResult> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(command, 'Transferring stock');

      const result = await this.inventoryGateway.transferStock(command, correlationId);

      this.logger.info(
        {
          variantId: command.variantId,
          fromOnHand: result.from.quantityOnHand,
          toOnHand: result.to.quantityOnHand,
        },
        'Stock transferred',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error transferring stock');

      throwRpcError(error);
    }
  }
}
