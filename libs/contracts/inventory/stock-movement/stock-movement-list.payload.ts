import { ICorrelationPayload } from '../../microservices';
import { StockMovementTypeEnum } from '../enums';

export interface IStockMovementListPayload extends ICorrelationPayload {
  variantId: number;
  page: number;
  size: number;
  type?: StockMovementTypeEnum;
  from?: string;
  to?: string;
}
