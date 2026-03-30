import { ICorrelationPayload } from '../../../common';

export interface IProductStockGetPayload extends ICorrelationPayload {
  productId: number;
  storageIds?: string[];
}
