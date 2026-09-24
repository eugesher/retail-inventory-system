import { PinoLogger } from 'nestjs-pino';

import { StockMovement } from '../../domain';
import { IStockEventsPublisherPort } from '../ports';

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
