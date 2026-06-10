import { AddressOwnerTypeEnum } from '@retail-inventory-system/contracts';

import { Address } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const ADDRESS_REPOSITORY = Symbol('ADDRESS_REPOSITORY');

// The repository seam for the polymorphic `Address` aggregate. Domain types only —
// no TypeORM leak (ADR-017); the persistence details live in
// `AddressTypeormRepository`.
//
// `save` upserts by the caller-assigned CHAR(36) UUID and re-reads for the
// committed timestamps; it accepts an optional `scope` so Place Order writes both
// snapshot addresses inside the same transaction as the order + cart-conversion
// writes (ADR-017 §6). `findByOwner` resolves all addresses for a
// `(ownerType, ownerId)` pair — backed by the composite `(owner_type, owner_id)`
// index — and is the read the order view uses to resolve an order's snapshotted
// billing/shipping rows.
export interface IAddressRepositoryPort {
  save(address: Address, scope?: ITransactionScope): Promise<Address>;
  findById(id: string): Promise<Address | null>;
  findByOwner(ownerType: AddressOwnerTypeEnum, ownerId: string): Promise<Address[]>;
}
