import { PinoLogger } from 'nestjs-pino';

import { StockMovement } from '../../domain';
import { IStockEventsPublisherPort } from '../ports';

// The shared post-commit announce for an appended ledger row (ADR-030 §2), hoisted
// out of every counter-changing use case (Receive / Adjust / Transfer / Allocate /
// Cancel / Release) so they share one best-effort emit policy — the `maybeEmitLowStock`
// precedent. The ledger row already committed with its counter inside the
// transaction; this only announces `inventory.stock-movement.recorded` afterwards, so
// a broker hiccup is warn-logged, never raised (failing the RPC would mislead the
// caller into thinking the committed write did not happen).
//
// `movement` is nullable so callers on the single-level path (Receive / Adjust pass
// `applyOnHandChange`'s nullable result) can forward it unguarded — a `null` (no
// `buildMovement` factory was supplied) is a no-op. The warn log reads `variantId`
// straight off the immutable record, so callers pass nothing extra.
export const emitMovementRecorded = async (
  publisher: IStockEventsPublisherPort,
  logger: PinoLogger,
  movement: StockMovement | null,
  correlationId?: string,
): Promise<void> => {
  if (movement === null) {
    return;
  }

  try {
    await publisher.publishStockMovementRecorded(movement, correlationId);
  } catch (error) {
    logger.warn(
      { err: error as Error, correlationId, variantId: movement.variantId },
      'Failed to publish inventory.stock-movement.recorded (write already committed)',
    );
  }
};
