import { StockMovementView } from '@retail-inventory-system/contracts';

import { StockMovement } from '../../domain';

export const toStockMovementView = (movement: StockMovement): StockMovementView => {
  if (movement.id === null) {
    throw new Error('toStockMovementView: movement id is unexpectedly null');
  }

  return {
    id: movement.id,
    variantId: movement.variantId,
    stockLocationId: movement.stockLocationId,
    type: movement.type,
    quantity: movement.quantity,
    reasonCode: movement.reasonCode,
    referenceType: movement.referenceType,
    referenceId: movement.referenceId,
    actorId: movement.actorId,
    occurredAt: movement.occurredAt.toISOString(),
  };
};
