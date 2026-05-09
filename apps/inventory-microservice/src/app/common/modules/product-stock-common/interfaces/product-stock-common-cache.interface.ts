import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';
import { ICorrelationPayload } from '@retail-inventory-system/observability';

export interface IProductStockCommonCacheGet extends ICorrelationPayload {
  productId: number;
  storageIds?: string[];
}

export interface IProductStockCommonCacheSet extends ICorrelationPayload {
  productId: number;
  storageIds?: string[];
  data: ProductStockGetResponseDto;
}

export interface IProductStockCommonCacheInvalidateItem {
  productId: number;
  storageId: string;
}

export interface IProductStockCommonCacheInvalidate extends ICorrelationPayload {
  items: IProductStockCommonCacheInvalidateItem[];
}
