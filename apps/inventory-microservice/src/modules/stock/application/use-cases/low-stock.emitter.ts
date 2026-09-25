import { PinoLogger } from 'nestjs-pino';

import { INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD } from '@retail-inventory-system/contracts';

import { StockLevel, StockLowEvent } from '../../domain';
import { IStockEventsPublisherPort } from '../ports';

export const maybeEmitLowStock = async (
  publisher: IStockEventsPublisherPort,
  logger: PinoLogger,
  saved: StockLevel,
  quantityDelta: number,
  correlationId?: string,
): Promise<void> => {
  if (quantityDelta >= 0 || saved.quantityOnHand > INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD) {
    return;
  }

  logger.info(
    {
      correlationId,
      variantId: saved.variantId,
      stockLocationId: saved.stockLocationId,
      quantity: saved.quantityOnHand,
      threshold: INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
    },
    'On-hand at/below threshold — emitting inventory.stock.low',
  );

  try {
    await publisher.publishStockLow(
      new StockLowEvent({
        variantId: saved.variantId,
        stockLocationId: saved.stockLocationId,
        quantity: saved.quantityOnHand,
        threshold: INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
      }),
      correlationId,
    );
  } catch (error) {
    logger.warn(
      { err: error as Error, correlationId, variantId: saved.variantId },
      'Failed to publish inventory.stock.low (write already committed)',
    );
  }
};
