import { ICorrelationPayload } from '../../../microservices';

export interface IProductStockGetPayload extends ICorrelationPayload {
  productId: number;
  storageIds?: string[];
}
