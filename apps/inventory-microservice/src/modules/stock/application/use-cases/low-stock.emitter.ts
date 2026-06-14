import { PinoLogger } from 'nestjs-pino';

import { INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD } from '@retail-inventory-system/contracts';

import { StockLevel, StockLowEvent } from '../../domain';
import { IStockEventsPublisherPort } from '../ports';

// The preserved low-stock alert, hoisted out of `AdjustStockUseCase` so Adjust and
// Transfer share one depletion-signal policy (ADR-012 §low-stock / ADR-030). It is
// best-effort and post-commit: the write already committed, so a publish failure is
// warn-logged, never raised.
//
// It is a **depletion** signal — it fires only when a DECREASE (`quantityDelta < 0`)
// drives the post-commit on-hand to at/below `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`.
// A write that raises stock (a positive delta) has not "fallen" and never raises a
// reorder alert. A transfer-out is always a negative delta on the source, so a
// transfer that empties a warehouse alerts exactly like a negative adjustment; the
// transfer's destination (a positive delta) is correctly never a low-stock event.
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
