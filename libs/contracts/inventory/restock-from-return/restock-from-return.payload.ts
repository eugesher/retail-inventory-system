import { ICorrelationPayload } from '../../microservices';

export interface IRestockFromReturnLine {
  returnLineId: number;
  variantId: number;
  stockLocationId: string;
  quantity: number;
}

export interface IRestockFromReturnPayload extends ICorrelationPayload {
  returnRequestId: number;
  lines: IRestockFromReturnLine[];
  actorId?: string | null;
}
