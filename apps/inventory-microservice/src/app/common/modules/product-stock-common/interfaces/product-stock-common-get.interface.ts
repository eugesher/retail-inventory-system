import { EntityManager } from 'typeorm';

import { ICorrelationPayload } from '@retail-inventory-system/common';

export interface IProductStockCommonGet extends ICorrelationPayload {
  productId: number;
  storageIds?: string[];
}

export interface IProductStockCommonGetOptions {
  entityManager?: EntityManager;
  ignoreCache?: boolean;
}

export interface IProductStockCommonMapGetLocked extends ICorrelationPayload {
  productIds: number[];
}

export interface IProductStockCommonGetRawResult {
  storageId: string;
  quantity: `${number}`;
  updatedAt: Date;
}
