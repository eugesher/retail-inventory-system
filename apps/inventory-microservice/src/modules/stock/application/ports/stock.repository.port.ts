import { StockLevel, StockLocation } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

export interface IStockRepositoryPort {
  findLocation(id: string): Promise<StockLocation | null>;
  listLocations(activeOnly?: boolean): Promise<StockLocation[]>;
  findStockLevel(
    variantId: number,
    stockLocationId: string,
    scope?: ITransactionScope,
  ): Promise<StockLevel | null>;
  findStockLevelsByVariant(variantId: number, stockLocationIds?: string[]): Promise<StockLevel[]>;
  saveStockLevel(stockLevel: StockLevel): Promise<StockLevel>;
  persistStockLevelChange(
    stockLevel: StockLevel,
    expectedVersion: number | null,
    scope?: ITransactionScope,
  ): Promise<StockLevel>;
}
