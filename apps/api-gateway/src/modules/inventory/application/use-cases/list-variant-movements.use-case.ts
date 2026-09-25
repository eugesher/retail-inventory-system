import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IPage,
  IStockMovementListPayload,
  StockMovementView,
} from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

@Injectable()
export class ListVariantMovementsUseCase {
  constructor(
    @Inject(INVENTORY_GATEWAY_PORT)
    private readonly inventoryGateway: IInventoryGatewayPort,
    @InjectPinoLogger(ListVariantMovementsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockMovementListPayload): Promise<IPage<StockMovementView>> {
    this.logger.assign({ correlationId: payload.correlationId });

    try {
      this.logger.info(
        { variantId: payload.variantId, page: payload.page, size: payload.size },
        'Listing stock movements',
      );

      const result = await this.inventoryGateway.listVariantMovements(payload);

      this.logger.info(
        { variantId: payload.variantId, total: result.total, returned: result.items.length },
        'Stock movements listed',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error listing stock movements');

      throwRpcError(error);
    }
  }
}
