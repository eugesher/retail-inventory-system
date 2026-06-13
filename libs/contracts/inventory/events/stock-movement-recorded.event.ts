import { ICorrelationPayload } from '../../microservices';
import { StockMovementTypeEnum } from '../enums';

// Wire-format shape for the `inventory.stock-movement.recorded` event, published
// for **every** insert into the append-only audit ledger (ADR-030 §2) — a
// high-volume stream whose intended consumer is a future event-store capability.
// It echoes the `StockMovementView` fields (renaming the row's `id` to
// `movementId` to disambiguate it on the wire) plus the standard event envelope.
//
// A reserved surface today: emitted onto `inventory_queue` with no cross-service
// consumer bound yet. `quantity` is **signed** (the per-type sign of ADR-030 §2).
// The publisher takes the domain `StockMovement` record directly (a wrapper event
// class would only duplicate the row). `eventVersion` is pinned to `'v1'`;
// `occurredAt` is ISO-8601.
export interface IInventoryStockMovementRecordedEvent extends ICorrelationPayload {
  movementId: number;
  variantId: number;
  stockLocationId: string;
  type: StockMovementTypeEnum;
  quantity: number;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorId: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
