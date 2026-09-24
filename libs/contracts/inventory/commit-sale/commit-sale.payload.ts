import { ICorrelationPayload } from '../../microservices';

export interface ICommitSaleLine {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
}

export interface ICommitSalePayload extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: string;
  lines: ICommitSaleLine[];
  actorId?: string | null;
}
