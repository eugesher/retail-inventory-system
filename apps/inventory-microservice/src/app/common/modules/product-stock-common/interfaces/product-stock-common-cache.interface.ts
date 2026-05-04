import { ICorrelationPayload } from '@retail-inventory-system/common';
import { ProductStockGetResponseDto } from '@retail-inventory-system/inventory';

export interface IProductStockCommonCacheGet extends ICorrelationPayload {
  productId: number;
  storageIds?: string[];
}

export interface IProductStockCommonCacheSet extends ICorrelationPayload {
  productId: number;
  storageIds?: string[];
  data: ProductStockGetResponseDto;
}
