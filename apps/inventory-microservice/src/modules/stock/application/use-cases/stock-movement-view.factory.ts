import { StockMovementView } from '@retail-inventory-system/contracts';

import { StockMovement } from '../../domain';

// Pure mapping from the immutable `StockMovement` domain record onto the wire
// `StockMovementView` — framework-free, the audit read's single mapping site (the
// `reservation-view.factory.ts` / `stock-view.factory.ts` precedent, ADR-025).
// `occurredAt` becomes an ISO-8601 string on the wire; every other field passes
// through unchanged (the view's nullable fields already match the record's).
//
// NOTE: the `inventory.stock-movement.recorded` *event* mapping in
// `StockRabbitmqPublisher` is deliberately NOT routed through here — that wire
// shape is an `IInventoryStockMovementRecordedEvent` (keyed `movementId`, plus the
// `eventVersion` / `correlationId` envelope fields), a genuinely different shape
// from this read view (keyed `id`, no envelope). One mapping per target shape.
export const toStockMovementView = (movement: StockMovement): StockMovementView => {
  if (movement.id === null) {
    // Only ever called on a persisted, listed row, whose BIGINT id is concrete; a
    // null here is an internal invariant breach (mapping a not-yet-appended
    // record), not a client error.
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
