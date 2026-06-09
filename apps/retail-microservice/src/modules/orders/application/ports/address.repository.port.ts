import { AddressOwnerTypeEnum } from '@retail-inventory-system/contracts';

import { Address } from '../../domain';

export const ADDRESS_REPOSITORY = Symbol('ADDRESS_REPOSITORY');

// The repository seam for the polymorphic `Address` aggregate. Domain types only —
// no TypeORM leak (ADR-017); the persistence details live in
// `AddressTypeormRepository`.
//
// `save` upserts by the caller-assigned CHAR(36) UUID and re-reads for the
// committed timestamps. `findByOwner` resolves all addresses for a
// `(ownerType, ownerId)` pair — backed by the composite `(owner_type, owner_id)`
// index — and is the read the order view uses to resolve an order's snapshotted
// billing/shipping rows. The order operations that produce and consume these arrive
// in later capabilities; this foundation only fixes the contract.
export interface IAddressRepositoryPort {
  save(address: Address): Promise<Address>;
  findById(id: string): Promise<Address | null>;
  findByOwner(ownerType: AddressOwnerTypeEnum, ownerId: string): Promise<Address[]>;
}
