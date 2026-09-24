import { ICorrelationPayload } from '../../microservices';

export interface IStockTransferPayload extends ICorrelationPayload {
  variantId: number;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  actorId?: string;
}
