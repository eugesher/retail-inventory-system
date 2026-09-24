import { ICorrelationPayload } from '../../microservices';
import { StockMovementTypeEnum } from '../enums';

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
