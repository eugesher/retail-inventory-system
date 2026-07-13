import { Address } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const ADDRESS_REPOSITORY = Symbol('ADDRESS_REPOSITORY');

// The repository seam for the polymorphic `Address` aggregate. Domain types only —
// no TypeORM leak (ADR-017); the persistence details live in
// `AddressTypeormRepository`.
//
// `save` upserts by the caller-assigned CHAR(36) UUID and re-reads for the
// committed timestamps; it accepts an optional `scope` so Place Order writes both
// snapshot addresses inside the same transaction as the order + cart-conversion
// writes (ADR-017 §6).
//
// Write-only, and deliberately so (ADR-049). An order's addresses are immutable
// snapshots; the order view surfaces `billingAddressId` / `shippingAddressId` and never
// resolves the rows, so this port had no read with a caller. The two it used to declare
// were worse than idle: `findByOwner(CUSTOMER, id)` returns a customer's address book —
// the concept the snapshot design exists to rule out (README §5).
export interface IAddressRepositoryPort {
  save(address: Address, scope?: ITransactionScope): Promise<Address>;
}
