import { ICorrelationPayload } from '../../microservices';
import { StockMovementTypeEnum } from '../enums';

// `inventory.stock-movement.recorded` — a **reserved surface** (README §2). Not dead code.
//
// **The system's highest-volume stream:** one event per insert into the append-only ledger
// (ADR-030 §2), so every receive, adjust, reserve, release, allocate, sale and return emits one
// of these *in addition to* its own typed event. A consumer that binds this is binding all of
// them.
//
// `quantity` is **signed**, per the fixed per-type sign (ADR-030 §2). `movementId` is the ledger
// row's `id`, renamed on the wire so it cannot be mistaken for the variant or the reference.
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
