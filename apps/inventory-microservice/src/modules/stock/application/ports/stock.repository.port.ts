import { StockLevel, StockLocation } from '../../domain';

export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

// Domain types only — no `typeorm` leak (ADR-017). Later capabilities consume
// these methods (Query Availability, List Locations, Receive, Adjust, the
// variant-created auto-init consumer); this foundation only needs them to
// compile and to be covered by the repository spec.
export interface IStockRepositoryPort {
  findLocation(id: string): Promise<StockLocation | null>;
  listLocations(activeOnly?: boolean): Promise<StockLocation[]>;
  findStockLevel(variantId: number, stockLocationId: string): Promise<StockLevel | null>;
  findStockLevelsByVariant(variantId: number, stockLocationIds?: string[]): Promise<StockLevel[]>;
  // Upsert; re-reads the saved row so the generated id comes back concrete.
  saveStockLevel(stockLevel: StockLevel): Promise<StockLevel>;
}
