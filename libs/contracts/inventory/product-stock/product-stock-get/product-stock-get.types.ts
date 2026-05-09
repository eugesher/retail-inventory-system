import { ICorrelationPayload } from '@retail-inventory-system/common';

export interface IProductStockGetPayload extends ICorrelationPayload {
  productId: number;
  storageIds?: string[];
}
