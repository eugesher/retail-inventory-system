import { Reservation } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');

// Domain types only — no `typeorm` leak (ADR-017). Every method takes an optional
// `ITransactionScope` so reservation reads/writes join the SAME unit of work as
// the `StockLevel` counter change: the Reserve / Release / Allocate use cases
// (later tasks) read the hold, mutate `stock_level.quantityReserved`, and persist
// both inside one `runInTransaction`, so a partial write can never leave the hold
// and the counter disagreeing.
export interface IReservationRepositoryPort {
  findById(id: string, scope?: ITransactionScope): Promise<Reservation | null>;
  // Resolves the hold for the all-statuses UNIQUE triple
  // `(cart_id, variant_id, stock_location_id)` — ANY status, since a released /
  // expired row is reused (reactivated), never duplicated, when a removed line is
  // re-added.
  findByKey(
    cartId: string,
    variantId: number,
    stockLocationId: string,
    scope?: ITransactionScope,
  ): Promise<Reservation | null>;
  // The cart's currently-held lines — used by Release-on-place / cleanup paths.
  listActiveByCart(cartId: string, scope?: ITransactionScope): Promise<Reservation[]>;
  // The cart's active holds for one variant (a cart could hold the same variant at
  // more than one location). Used by the re-reserve quantity-delta computation.
  listActiveByCartAndVariant(
    cartId: string,
    variantId: number,
    scope?: ITransactionScope,
  ): Promise<Reservation[]>;
  // The sweep's candidate scan: `active` holds whose TTL has already elapsed, oldest
  // first, capped at `limit`. Served by `IDX_RESERVATION_STATUS_EXPIRES_AT`. The rows
  // are candidates only — the sweep re-reads each by id inside its transaction, so a
  // hold released or refreshed between the scan and the write is observed there, not
  // here.
  listExpiredActive(now: Date, limit: number, scope?: ITransactionScope): Promise<Reservation[]>;
  // Insert-or-update by id, re-reading so the committed `version` and DB timestamps come back
  // concrete.
  //
  // **A lost INSERT race on the UNIQUE triple is translated into `StockWriteConflictError`** — the
  // same error a lost compare-and-swap raises — so `runWithStockWriteRetry` cannot tell them apart
  // and re-reads and converges either way. Two shoppers racing to hold the last unit of the same
  // variant is a *normal* outcome, not a driver error.
  save(reservation: Reservation, scope?: ITransactionScope): Promise<Reservation>;
}
