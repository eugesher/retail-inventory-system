import { Reservation } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');

export interface IReservationRepositoryPort {
  findById(id: string, scope?: ITransactionScope): Promise<Reservation | null>;
  findByKey(
    cartId: string,
    variantId: number,
    stockLocationId: string,
    scope?: ITransactionScope,
  ): Promise<Reservation | null>;
  listActiveByCart(cartId: string, scope?: ITransactionScope): Promise<Reservation[]>;
  listActiveByCartAndVariant(
    cartId: string,
    variantId: number,
    scope?: ITransactionScope,
  ): Promise<Reservation[]>;
  listExpiredActive(now: Date, limit: number, scope?: ITransactionScope): Promise<Reservation[]>;
  save(reservation: Reservation, scope?: ITransactionScope): Promise<Reservation>;
}
