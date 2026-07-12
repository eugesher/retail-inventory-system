import { PinoLogger } from 'nestjs-pino';

import { INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD } from '@retail-inventory-system/contracts';

import { StockLevel, StockLowEvent } from '../../domain';
import { IStockEventsPublisherPort } from '../ports';

// The one depletion-signal policy, shared by every write that can lower on-hand — so a warehouse
// emptied by a transfer, by an adjustment or by a shipment all alert identically.
//
// **It is a DEPLETION signal, not a level check.** It fires only when a *decrease* drives the
// post-commit on-hand to at-or-below the threshold. A positive delta has not "fallen" and never
// alerts — which is right for a transfer's destination leg, and is also why **silence proves
// nothing**: a level that is already low and stays low raises no event, because nothing crossed the
// line.
//
// Best-effort and post-commit: the write is already durable, so a publish failure is warn-logged
// and swallowed. Losing the alert must never lose the stock movement.
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
