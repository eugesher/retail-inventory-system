import { StockLevel, StockLocation } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

// Domain types only — no `typeorm` leak (ADR-017). Later capabilities consume
// these methods (Query Availability, List Locations, Receive, Adjust, the
// variant-created auto-init consumer); this foundation only needs them to
// compile and to be covered by the repository spec.
export interface IStockRepositoryPort {
  findLocation(id: string): Promise<StockLocation | null>;
  listLocations(activeOnly?: boolean): Promise<StockLocation[]>;
  // Reads one variant/location level. When a transaction `scope` is supplied the
  // read runs on the transactional manager, so it is part of the same unit of
  // work as the subsequent `persistStockLevelChange` (ADR-027 §concurrency).
  findStockLevel(
    variantId: number,
    stockLocationId: string,
    scope?: ITransactionScope,
  ): Promise<StockLevel | null>;
  findStockLevelsByVariant(variantId: number, stockLocationIds?: string[]): Promise<StockLevel[]>;
  // Upsert; re-reads the saved row so the generated id comes back concrete. Used
  // by the auto-init consumer (a single insert, no optimistic contention).
  saveStockLevel(stockLevel: StockLevel): Promise<StockLevel>;
  // Optimistic write for the read-modify-write paths (Receive / Adjust). When
  // `expectedVersion` is a number it issues a version-checked UPDATE
  // (`SET version = version + 1 WHERE id = :id AND version = :expectedVersion`)
  // and throws `StockWriteConflictError` if it matched zero rows — a concurrent
  // writer advanced the row first. When `expectedVersion` is null it is a
  // first-touch INSERT, throwing `StockWriteConflictError` if the
  // `UNIQUE (variant_id, stock_location_id)` race was lost. Re-reads the row so
  // the returned aggregate carries the committed version + timestamps.
  persistStockLevelChange(
    stockLevel: StockLevel,
    expectedVersion: number | null,
    scope?: ITransactionScope,
  ): Promise<StockLevel>;
}
