import { Reservation } from '../../domain';
import { ITransactionScope } from './transaction.port';

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
  // Insert-or-update by id; re-reads the saved row so the committed `version` and
  // the DB timestamps come back concrete. A lost INSERT race on the UNIQUE triple
  // is translated to `StockWriteConflictError` so the shared bounded-retry write
  // protocol (a later capability) re-reads and converges.
  save(reservation: Reservation, scope?: ITransactionScope): Promise<Reservation>;
}
