import { VariantStockView } from '@retail-inventory-system/contracts';

export const STOCK_CACHE = Symbol('STOCK_CACHE');

export interface IStockCacheGetPayload {
  variantId: number;
  stockLocationIds?: string[];
  tenantId?: string;
  correlationId?: string;
}

export interface IStockCacheSetPayload {
  variantId: number;
  stockLocationIds?: string[];
  tenantId?: string;
  data: VariantStockView;
  correlationId?: string;
}

export interface IStockCacheInvalidateItem {
  variantId: number;
  stockLocationId: string;
}

export interface IStockCacheGetResult {
  value: VariantStockView | undefined;
  available: boolean;
}

export interface IStockWithInvalidationOptions {
  tenantId?: string;
  correlationId?: string;
}

export interface IStockCachePort {
  getOrLoad(
    payload: IStockCacheGetPayload,
    loader: () => Promise<VariantStockView>,
  ): Promise<VariantStockView>;
  withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T>;
}
