import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

export const STOCK_CACHE = Symbol('STOCK_CACHE');

export interface IStockCacheGetPayload {
  productId: number;
  storageIds?: string[];
  correlationId?: string;
}

export interface IStockCacheSetPayload {
  productId: number;
  storageIds?: string[];
  data: ProductStockGetResponseDto;
  correlationId?: string;
}

export interface IStockCacheInvalidateItem {
  productId: number;
  storageId: string;
}

export interface IStockCacheInvalidatePayload {
  items: IStockCacheInvalidateItem[];
  correlationId?: string;
}

// Stock-specific cache port. Sits on top of the generic CACHE_PORT
// (`libs/cache`) but knows the stock cache-key shape so use cases never
// touch raw key strings. The adapter preserves the ADR-002 cache-aside
// contract verbatim — SCAN+UNLINK on Redis, named-key fallback elsewhere.
export interface IStockCachePort {
  get(payload: IStockCacheGetPayload): Promise<ProductStockGetResponseDto | undefined>;
  set(payload: IStockCacheSetPayload): Promise<void>;
  invalidate(payload: IStockCacheInvalidatePayload): Promise<void>;
}
